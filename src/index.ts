import { Hono } from "hono";
import type { Context } from "hono";
import type { Request as CfRequest } from "@cloudflare/workers-types";
import { MyMCP } from "./agents/my-mcp";
import type { Env } from "./types";
import { LongTaskDurableObject } from "./durable/long-task";

const app = new Hono<{ Bindings: Env }>();

app.mount("/mcp", MyMCP.serve("/mcp").fetch, { replaceRequest: false });
app.mount("/sse", MyMCP.serveSSE("/sse").fetch, { replaceRequest: false });

app.get("/api/tools", async c => {
  const agent = MyMCP.shared();
  await agent.ready(c.env, c.executionCtx);
  const tools = await agent.listTools();
  return c.json({ tools });
});

app.post("/api/tools/:name", async c => {
  const agent = MyMCP.shared();
  const name = c.req.param("name");
  let body: { arguments?: Record<string, unknown> };
  try {
    body = await c.req.json();
  } catch (error) {
    return c.json({ error: `Invalid JSON body: ${error instanceof Error ? error.message : String(error)}` }, 400);
  }

  try {
    const result = await agent.invokeTool(
      name,
      body.arguments ?? {},
      c.req.raw,
      c.env,
      c.executionCtx,
    );
    return c.json(result);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

const proxyAsset = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
  const request = c.req.raw as unknown as CfRequest;
  const response = await c.env.ASSETS.fetch(request);
  const headers = new Headers();
  response.headers.forEach((value, key) => headers.set(key, value));
  const buffer = await response.arrayBuffer();
  return new Response(buffer, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

app.get("/openapi.json", proxyAsset);

app.get("/", proxyAsset);

app.all("*", async c => {
  const result = await proxyAsset(c);
  if (result.status === 404) {
    return c.text("Not found", 404);
  }
  return result;
});

export { LongTaskDurableObject };
export default app;
