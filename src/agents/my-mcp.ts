import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types";
import { McpAgent } from "./mcp";
import type {
  Env,
  RemoteToolConfig,
  RemoteToolField,
} from "../types";
import type {
  HeadersInit as CfHeadersInit,
  RequestInit as CfRequestInit,
  Response as CfResponse,
  VectorizeVectorMetadataFilter,
} from "@cloudflare/workers-types";

const DEFAULT_BROWSER_ENDPOINT = "https://browser.render.cloudflare.com/render";

const scalarField = (field: RemoteToolField): z.ZodTypeAny => {
  switch (field.type) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(field.items ? scalarField(field.items) : z.any());
    case "object":
      return z.object(
        Object.fromEntries(
          Object.entries(field.properties ?? {}).map(([key, value]) => [
            key,
            value.optional ? scalarField(value).optional() : scalarField(value),
          ]),
        ),
      );
    default:
      return z.any();
  }
};

const jsonSchemaFromField = (field: RemoteToolField): Record<string, unknown> => {
  switch (field.type) {
    case "string":
      return { type: "string", description: field.description };
    case "number":
      return { type: "number", description: field.description };
    case "boolean":
      return { type: "boolean", description: field.description };
    case "array":
      return {
        type: "array",
        description: field.description,
        items: field.items ? jsonSchemaFromField(field.items) : {},
      };
    case "object":
      return {
        type: "object",
        description: field.description,
        properties: Object.fromEntries(
          Object.entries(field.properties ?? {}).map(([key, value]) => [
            key,
            jsonSchemaFromField(value),
          ]),
        ),
        required: Object.entries(field.properties ?? {})
          .filter(([, value]) => !value.optional)
          .map(([key]) => key),
      };
    default:
      return { description: field.description };
  }
};

type AgentState = {
  remoteTools: string[];
};

export class MyMCP extends McpAgent<Env, AgentState> {
  constructor() {
    super({ name: "Cloudflare MCP Worker", version: "1.0.0" }, { remoteTools: [] });
  }

  protected override async init(): Promise<void> {
    this.registerBrowserTool();
    this.registerD1Tool();
    this.registerKvTool();
    this.registerVectorizeTool();
    this.registerDurableTool();
    await this.registerRemoteTools();
  }

  private registerBrowserTool(): void {
    const schema = z.object({
      url: z.string().url(),
      endpoint: z.string().url().optional(),
      method: z.enum(["GET", "POST"]).optional(),
      waitFor: z.number().int().min(0).max(120_000).optional(),
      screenshot: z.boolean().optional(),
      script: z.string().optional(),
      headers: z.record(z.string()).optional(),
      metadata: z.record(z.any()).optional(),
    });

    this.registerTool({
      name: "browser_render",
      description: "Render a web page using Cloudflare Browser Rendering and optionally run a Playwright script.",
      schema,
      handler: async ({ args, env }) => {
        const endpoint = args.endpoint ?? DEFAULT_BROWSER_ENDPOINT;
        const method = (args.method ?? "POST").toUpperCase();
        const payload = {
          url: args.url,
          waitFor: args.waitFor,
          screenshot: args.screenshot,
          script: args.script,
          metadata: args.metadata,
        };

        const headers: CfHeadersInit = {
          "content-type": "application/json",
          ...(args.headers ?? {}),
        };

        const requestInit: CfRequestInit = {
          method,
          headers,
        };

        if (method === "GET") {
          const url = new URL(endpoint);
          Object.entries(payload).forEach(([key, value]) => {
            if (typeof value === "undefined" || value === null) {
              return;
            }
            url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
          });
          const response = await env.BROWSER.fetch(url.toString(), requestInit);
          const result = await this.parseResponse(response);
          return this.wrapToolResult(result, endpoint);
        }

        requestInit.body = JSON.stringify(payload);
        const response = await env.BROWSER.fetch(endpoint, requestInit);
        const result = await this.parseResponse(response);
        return this.wrapToolResult(result, endpoint);
      },
    });
  }

  private registerD1Tool(): void {
    const statementSchema = z.object({
      sql: z.string(),
      params: z.array(z.any()).optional(),
    });
    const schema = z.object({
      statement: statementSchema.optional(),
      statements: z.array(statementSchema).optional(),
      readOnly: z.boolean().optional(),
    });

    this.registerTool({
      name: "d1_query",
      description: "Execute SQL against the bound D1 database, supporting single or batched statements.",
      schema,
      handler: async ({ args, env }) => {
        if (args.statements) {
          const exec = args.statements.map(statement => {
            const prepared = env.DB.prepare(statement.sql);
            return statement.params ? prepared.bind(...statement.params) : prepared;
          });
          const rows = await env.DB.batch(exec);
          return this.wrapToolResult(rows, "d1");
        }

        if (!args.statement) {
          throw new Error("No SQL statement provided.");
        }

        const stmt = env.DB.prepare(args.statement.sql);
        const query = args.statement.params ? stmt.bind(...args.statement.params) : stmt;
        const result = await query.all();
        return this.wrapToolResult(result, "d1");
      },
    });
  }

  private registerKvTool(): void {
    const schema = z.object({
      action: z.enum(["get", "put", "delete", "list"]),
      key: z.string().optional(),
      value: z.string().optional(),
      metadata: z.record(z.any()).optional(),
      expirationTtl: z.number().int().positive().optional(),
      prefix: z.string().optional(),
      limit: z.number().int().min(1).max(1000).optional(),
      type: z.enum(["text", "json", "arrayBuffer"]).optional(),
    });

    this.registerTool({
      name: "kv",
      description: "Perform CRUD operations against the bound KV namespace.",
      schema,
      handler: async ({ args, env }) => {
        switch (args.action) {
          case "get": {
            if (!args.key) throw new Error("Key is required for get action.");
            const type = args.type ?? "json";
            if (type === "arrayBuffer") {
              const value = await env.KV.get(args.key, { type: "arrayBuffer" });
              const bytes = value ? Array.from(new Uint8Array(value)) : [];
              return this.wrapToolResult({ bytes }, "kv");
            }
            if (type === "text") {
              const value = await env.KV.get(args.key, { type: "text" });
              return this.wrapToolResult(value ?? "", "kv");
            }
            const value = await env.KV.get(args.key, { type: "json" });
            return this.wrapToolResult(value, "kv");
          }
          case "put": {
            if (!args.key) throw new Error("Key is required for put action.");
            if (typeof args.value === "undefined") throw new Error("Value is required for put action.");
            await env.KV.put(args.key, args.value, {
              expirationTtl: args.expirationTtl,
              metadata: args.metadata,
            });
            return this.wrapToolResult({ message: `Stored value at ${args.key}` }, "kv");
          }
          case "delete": {
            if (!args.key) throw new Error("Key is required for delete action.");
            await env.KV.delete(args.key);
            return this.wrapToolResult({ message: `Deleted ${args.key}` }, "kv");
          }
          case "list": {
            const list = await env.KV.list({ prefix: args.prefix, limit: args.limit });
            return this.wrapToolResult(list, "kv");
          }
          default:
            throw new Error(`Unsupported action: ${args.action}`);
        }
      },
    });
  }

  private registerVectorizeTool(): void {
    const vectorSchema = z.object({
      id: z.string(),
      values: z.array(z.number()),
      metadata: z.record(z.any()).optional(),
    });
    const schema = z.object({
      action: z.enum(["upsert", "query", "delete"]),
      vectors: z.array(vectorSchema).optional(),
      vector: z.array(z.number()).optional(),
      topK: z.number().int().positive().optional(),
      filter: z.record(z.any()).optional(),
      ids: z.array(z.string()).optional(),
    });

    this.registerTool({
      name: "vectorize",
      description: "Interact with the Cloudflare Vectorize index for semantic storage and retrieval.",
      schema,
      handler: async ({ args, env }) => {
        switch (args.action) {
          case "upsert": {
            if (!args.vectors?.length) {
              throw new Error("Vectors are required for upsert.");
            }
            await env.VECTORIZE.upsert(args.vectors.map(vector => ({
              id: vector.id,
              values: vector.values,
              metadata: vector.metadata,
            })));
            return this.wrapToolResult({ message: `Upserted ${args.vectors.length} vectors.` }, "vectorize");
          }
          case "query": {
            if (!args.vector) throw new Error("Query vector is required.");
            const result = await env.VECTORIZE.query(args.vector, {
              topK: args.topK ?? 5,
              filter: args.filter as VectorizeVectorMetadataFilter | undefined,
            });
            return this.wrapToolResult(result, "vectorize");
          }
          case "delete": {
            if (!args.ids?.length) throw new Error("Vector IDs are required for delete.");
            await env.VECTORIZE.deleteByIds(args.ids);
            return this.wrapToolResult({ message: `Deleted ${args.ids.length} vectors.` }, "vectorize");
          }
          default:
            throw new Error(`Unsupported Vectorize action: ${args.action}`);
        }
      },
    });
  }

  private registerDurableTool(): void {
    const schema = z.object({
      action: z.enum(["start", "status", "list", "cancel"]),
      taskId: z.string().optional(),
      payload: z
        .object({
          operation: z.string(),
          data: z.record(z.any()).optional(),
          durationMs: z.number().int().positive().optional(),
        })
        .optional(),
    });

    this.registerTool({
      name: "durable_task",
      description: "Interact with the Durable Object for long-running workflows.",
      schema,
      handler: async ({ args, env }) => {
        const id = env.LONG_TASK.idFromName("mcp");
        const stub = env.LONG_TASK.get(id);
        const base = "https://durable-task";

        switch (args.action) {
          case "start": {
            if (!args.payload) {
              throw new Error("payload is required to start a task");
            }
            const response = await stub.fetch(`${base}/task`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(args.payload),
            });
            const data = await response.json();
            return this.wrapToolResult(data, "durable_task");
          }
          case "status": {
            if (!args.taskId) throw new Error("taskId is required for status");
            const response = await stub.fetch(`${base}/task/${args.taskId}`);
            if (response.status === 404) {
              return this.wrapError(`Task ${args.taskId} not found.`, "durable_task");
            }
            const data = await response.json();
            return this.wrapToolResult(data, "durable_task");
          }
          case "list": {
            const response = await stub.fetch(`${base}/task`);
            const data = await response.json();
            return this.wrapToolResult(data, "durable_task");
          }
          case "cancel": {
            if (!args.taskId) throw new Error("taskId is required for cancel");
            const response = await stub.fetch(`${base}/task/${args.taskId}`, { method: "DELETE" });
            const data = await response.json();
            return this.wrapToolResult(data, "durable_task");
          }
          default:
            throw new Error(`Unsupported action: ${args.action}`);
        }
      },
    });
  }

  private async registerRemoteTools(): Promise<void> {
    const raw = this.env.MCP_REMOTE_TOOLS;
    if (!raw) {
      return;
    }

    let parsed: RemoteToolConfig[] = [];
    try {
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        parsed = data as RemoteToolConfig[];
      }
    } catch (error) {
      console.error("Failed to parse MCP_REMOTE_TOOLS", error);
      return;
    }

    const registered: string[] = [];

    for (const config of parsed) {
      if (!config?.name || !config?.endpoint) {
        continue;
      }

      const shapeEntries = Object.entries(config.schema ?? {}).map(([key, field]) => {
        const schema = scalarField(field);
        return [key, field.optional ? schema.optional() : schema] as const;
      });
      const shape = Object.fromEntries(shapeEntries);
      const schema = z.object(shape).catchall(z.any());
      const jsonSchema = {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(config.schema ?? {}).map(([key, field]) => [key, jsonSchemaFromField(field)]),
        ),
        required: Object.entries(config.schema ?? {})
          .filter(([, field]) => !field.optional)
          .map(([key]) => key),
      } satisfies Record<string, unknown>;

      this.registerTool({
        name: config.name,
        description: config.description ?? `Proxy request to ${config.endpoint}`,
        schema,
        jsonSchemaOverride: jsonSchema,
        handler: async ({ args }) => {
          const method = (config.method ?? "POST").toUpperCase();
          const headers: CfHeadersInit = {
            "content-type": "application/json",
            ...(config.headers ?? {}),
          };

          let response: CfResponse;
          if (method === "GET") {
            const url = new URL(config.endpoint);
            Object.entries(args).forEach(([key, value]) => {
              if (typeof value === "undefined" || value === null) return;
              url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
            });
            response = (await fetch(url.toString(), { method, headers })) as unknown as CfResponse;
          } else {
            response = (await fetch(config.endpoint, {
              method,
              headers,
              body: JSON.stringify(args),
            })) as unknown as CfResponse;
          }

          const payload = await this.parseResponse(response);
          if (!response.ok) {
            const message =
              typeof payload === "string"
                ? payload
                : `Remote tool ${config.name} failed with status ${response.status}`;
            return this.wrapError(message, config.endpoint, payload);
          }

          return this.wrapToolResult(payload, config.endpoint);
        },
      });

      registered.push(config.name);
    }

    if (registered.length) {
      this.setState({ remoteTools: registered });
    }
  }

  private async parseResponse(response: Response | CfResponse): Promise<unknown> {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private wrapToolResult(result: unknown, endpoint: string): CallToolResult {
    const text =
      typeof result === "string"
        ? result
        : JSON.stringify(result ?? null, null, 2);
    return {
      content: [
        {
          type: "text",
          text,
        },
      ],
      metadata: { endpoint },
    };
  }

  private wrapError(message: string, endpoint: string, data?: unknown): CallToolResult {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: message,
        },
      ],
      metadata: { endpoint },
    };
  }
}
