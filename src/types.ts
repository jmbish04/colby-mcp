import type {
  D1Database,
  DurableObjectNamespace,
  Fetcher,
  KVNamespace,
  VectorizeIndex,
} from "@cloudflare/workers-types";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  KV: KVNamespace;
  VECTORIZE: VectorizeIndex;
  BROWSER: Fetcher;
  LONG_TASK: DurableObjectNamespace;
  MCP_REMOTE_TOOLS?: string;
}

export type DurableTaskPayload = {
  operation: string;
  data?: Record<string, unknown> | null;
  durationMs?: number;
};

export type RemoteToolField = {
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  optional?: boolean;
  items?: RemoteToolField;
  properties?: Record<string, RemoteToolField>;
};

export type RemoteToolConfig = {
  name: string;
  description: string;
  endpoint: string;
  method?: string;
  headers?: Record<string, string>;
  schema?: Record<string, RemoteToolField>;
};
