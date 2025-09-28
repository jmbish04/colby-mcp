import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import type {
  CallToolResult,
  Implementation,
  JSONRPCMessage,
  MessageExtraInfo,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import { z, type ZodObject, type ZodRawShape, type ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

type AnyZodObject = ZodObject<ZodRawShape, "strip", ZodTypeAny>;

type ToolHandler<Args extends AnyZodObject | null, Env, State> = (params: {
  args: Args extends AnyZodObject ? z.infer<Args> : Record<string, unknown>;
  env: Env;
  state: State;
  request?: Request;
  executionCtx: ExecutionContext;
  extra?: unknown;
}) => Promise<CallToolResult> | CallToolResult;

type ToolRegistration<Env, State> = {
  name: string;
  description: string;
  schema: AnyZodObject | null;
  annotations?: ToolAnnotations;
  handler: ToolHandler<AnyZodObject | null, Env, State>;
  jsonSchema?: Record<string, unknown>;
};

type SessionCleanup = () => Promise<void> | void;

interface WebSocketSession {
  close: SessionCleanup;
}

interface SseSession<Env> {
  id: string;
  close: SessionCleanup;
  send: (chunk: string) => void;
  transport: WorkerSseTransport<Env>;
}

class WorkerWebSocketTransport implements Transport {
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: (
    message: JSONRPCMessage,
    extra?: MessageExtraInfo,
  ) => void;
  private started = false;

  constructor(private readonly socket: WebSocket) {}

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.socket.addEventListener("message", (event: MessageEvent<string>) => {
      try {
        const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        this.onmessage?.(data);
      } catch (error) {
        this.onerror?.(
          error instanceof Error ? error : new Error(`Failed to parse WebSocket message: ${String(error)}`),
        );
      }
    });
    this.socket.addEventListener("close", () => {
      this.onclose?.();
    });
    this.socket.addEventListener("error", evt => {
      const error = evt instanceof ErrorEvent ? evt.error : new Error("WebSocket error");
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.socket.send(JSON.stringify(message));
  }

  async close(): Promise<void> {
    try {
      this.socket.close();
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

class WorkerSseTransport<Env> implements Transport {
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: (
    message: JSONRPCMessage,
    extra?: MessageExtraInfo,
  ) => void;
  private started = false;
  public sessionId?: string;

  constructor(
    private readonly session: string,
    private readonly sendChunk: (chunk: string) => void,
    private readonly closeStream: () => void,
  ) {
    this.sessionId = session;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
  }

  receive(message: unknown): void {
    try {
      if (!this.onmessage) {
        return;
      }
      this.onmessage(message as JSONRPCMessage);
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.sendChunk(`data: ${JSON.stringify(message)}\n\n`);
  }

  async close(): Promise<void> {
    this.closeStream();
    this.onclose?.();
  }
}

function encodeChunk(chunk: string): Uint8Array {
  return new TextEncoder().encode(chunk);
}

export abstract class McpAgent<Env, State extends Record<string, unknown> | undefined = undefined> {
  protected state: State;
  protected env!: Env;
  protected executionCtx!: ExecutionContext;

  private initialized = false;
  private readonly tools = new Map<string, ToolRegistration<Env, State>>();
  private readonly wsSessions = new Set<WebSocketSession>();
  private readonly sseSessions = new Map<string, SseSession<Env>>();

  constructor(private readonly info: Implementation, initialState: State) {
    this.state = initialState;
  }

  protected abstract init(): Promise<void> | void;
  protected onStateUpdate(_state: State): void {}

  protected setState(next: State): void {
    this.state = next;
    this.onStateUpdate(next);
  }

  protected registerTool<Args extends AnyZodObject | null>(definition: {
    name: string;
    description: string;
    schema?: Args | null;
    annotations?: ToolAnnotations;
    jsonSchemaOverride?: Record<string, unknown>;
    handler: ToolHandler<Args extends AnyZodObject ? Args : null, Env, State>;
  }): void {
    const { name, description, schema = null, handler, annotations, jsonSchemaOverride } = definition;
    if (this.tools.has(name)) {
      throw new Error(`Tool ${name} already registered`);
    }

    this.tools.set(name, {
      name,
      description,
      schema: schema as AnyZodObject | null,
      annotations,
      handler: handler as ToolHandler<AnyZodObject | null, Env, State>,
      jsonSchema: jsonSchemaOverride,
    });
  }

  private async ensureInitialized(env: Env, ctx: ExecutionContext): Promise<void> {
    if (!this.initialized) {
      this.env = env;
      this.executionCtx = ctx;
      await this.init();
      this.initialized = true;
    } else {
      this.env = env;
      this.executionCtx = ctx;
    }
  }

  private createServer(env: Env, ctx: ExecutionContext): McpServer {
    const server = new McpServer(this.info);

    for (const tool of this.tools.values()) {
      const toolCallback = async (
        args: Record<string, unknown>,
        extra: unknown,
      ) => {
        const parsedArgs = tool.schema ? (await tool.schema.parseAsync(args)) : (args ?? {});
        return tool.handler({
          args: parsedArgs,
          env,
          state: this.state,
          request: (extra as { requestInfo?: { request?: Request } } | undefined)?.requestInfo?.request,
          executionCtx: ctx,
          extra,
        });
      };

      if (tool.schema) {
        server.registerTool(tool.name, {
          description: tool.description,
          inputSchema: tool.schema.shape as ZodRawShape,
          annotations: tool.annotations,
        }, toolCallback);
      } else {
        server.registerTool(tool.name, {
          description: tool.description,
          annotations: tool.annotations,
        }, toolCallback);
      }
    }

    return server;
  }

  async listTools(): Promise<
    Array<{ name: string; description: string; schema: Record<string, unknown>; annotations?: ToolAnnotations }>
  > {
    const tools: Array<{ name: string; description: string; schema: Record<string, unknown>; annotations?: ToolAnnotations }> = [];
    for (const tool of this.tools.values()) {
      const schema =
        tool.jsonSchema ??
        (tool.schema
          ? (zodToJsonSchema(tool.schema, {
              name: `${tool.name}Input`,
              $refStrategy: "none",
            }) as Record<string, unknown>)
          : { type: "object", additionalProperties: true });
      tools.push({ name: tool.name, description: tool.description, schema, annotations: tool.annotations });
    }
    return tools;
  }

  async invokeTool(
    name: string,
    args: Record<string, unknown>,
    request: Request | undefined,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<CallToolResult> {
    await this.ensureInitialized(env, ctx);
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool ${name} not found`);
    }
    const parsedArgs = tool.schema ? await tool.schema.parseAsync(args ?? {}) : args ?? {};
    return tool.handler({ args: parsedArgs, env: this.env, state: this.state, request, executionCtx: this.executionCtx });
  }

  private async handleWebSocketRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    await this.ensureInitialized(env, ctx);

    const pair = new WebSocketPair();
    const [client, serverSocket] = Object.values(pair) as [WebSocket, WebSocket];
    serverSocket.accept();

    const transport = new WorkerWebSocketTransport(serverSocket);
    const server = this.createServer(env, ctx);
    await server.connect(transport);

    const session: WebSocketSession = {
      close: async () => {
        await transport.close();
        await server.close();
        this.wsSessions.delete(session);
      },
    };

    this.wsSessions.add(session);

    serverSocket.addEventListener("close", () => {
      ctx.waitUntil(Promise.resolve(session.close()));
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  async ready(env: Env, ctx: ExecutionContext): Promise<void> {
    await this.ensureInitialized(env, ctx);
  }

  private async handleSseRequest(request: Request, env: Env, ctx: ExecutionContext, endpoint: string): Promise<Response> {
    const url = new URL(request.url);
    const sessionId = url.pathname.replace(endpoint, "").replace(/^\/+/, "");

    if (request.method === "GET" && (sessionId === "" || sessionId === undefined)) {
      await this.ensureInitialized(env, ctx);
      const id = crypto.randomUUID();
      const agent = this;
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          controller = ctrl;
          ctrl.enqueue(encodeChunk(`: session ${id}\n\n`));
        },
        cancel: async () => {
          const session = agent.sseSessions.get(id);
          if (session) {
            await session.close();
          }
          agent.sseSessions.delete(id);
        },
      });

      const sendChunk = (chunk: string) => {
        if (controller) {
          controller.enqueue(encodeChunk(chunk));
        }
      };
      const closeStream = () => {
        if (controller) {
          try {
            controller.close();
          } catch (error) {
            console.warn("SSE stream already closed", error);
          }
        }
      };
      const transport = new WorkerSseTransport<Env>(id, sendChunk, closeStream);
      const server = this.createServer(env, ctx);
      await server.connect(transport);

      const heartbeat = setInterval(() => {
        sendChunk(`: heartbeat ${new Date().toISOString()}\n\n`);
      }, 15000);

      const cleanup = async () => {
        clearInterval(heartbeat);
        await transport.close();
        await server.close();
      };

      this.sseSessions.set(id, {
        id,
        close: cleanup,
        send: sendChunk,
        transport,
      });

      const headers = new Headers({
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-mcp-session": id,
        "access-control-expose-headers": "x-mcp-session",
      });

      return new Response(stream, { status: 200, headers });
    }

    if (!sessionId) {
      return new Response("Missing session ID", { status: 400 });
    }

    const session = this.sseSessions.get(sessionId);
    if (!session) {
      return new Response("Session not found", { status: 404 });
    }

    if (request.method === "POST") {
      const body = await request.json();
      const messages = Array.isArray(body) ? body : [body];
      for (const message of messages) {
        session.transport.receive(message);
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (request.method === "DELETE") {
      await session.close();
      this.sseSessions.delete(sessionId);
      return new Response(null, { status: 204 });
    }

    return new Response("Unsupported method", { status: 405 });
  }

  static serve<Path extends string, Env, State extends Record<string, unknown> | undefined>(
    this: new () => McpAgent<Env, State>,
    endpoint: Path,
  ) {
    const agent = McpAgent.getOrCreateInstance(this);
    return {
      fetch(request: Request, env: Env, ctx: ExecutionContext) {
        return agent.handleWebSocketRequest(request, env, ctx);
      },
    };
  }

  static serveSSE<Path extends string, Env, State extends Record<string, unknown> | undefined>(
    this: new () => McpAgent<Env, State>,
    endpoint: Path,
  ) {
    const agent = McpAgent.getOrCreateInstance(this);
    return {
      fetch(request: Request, env: Env, ctx: ExecutionContext) {
        return agent.handleSseRequest(request, env, ctx, endpoint);
      },
    };
  }

  private static readonly instances = new WeakMap<Function, McpAgent<any, any>>();

  protected static getOrCreateInstance<Env, State extends Record<string, unknown> | undefined>(
    AgentClass: new () => McpAgent<Env, State>,
  ): McpAgent<Env, State> {
    let instance = this.instances.get(AgentClass as unknown as Function);
    if (!instance) {
      instance = new AgentClass();
      this.instances.set(AgentClass as unknown as Function, instance as McpAgent<any, any>);
    }
    return instance as McpAgent<Env, State>;
  }

  static shared<Env, State extends Record<string, unknown> | undefined>(
    this: new () => McpAgent<Env, State>,
  ): McpAgent<Env, State> {
    return McpAgent.getOrCreateInstance(this);
  }
}
