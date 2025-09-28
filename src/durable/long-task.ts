import type { DurableObjectState } from "@cloudflare/workers-types";
import type { DurableTaskPayload, Env } from "../types";

const STORAGE_PREFIX = "task:";

type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

type StoredTask = {
  id: string;
  status: TaskStatus;
  operation: string;
  data?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  runAt: number;
  durationMs: number;
  result?: Record<string, unknown>;
  error?: string;
};

export class LongTaskDurableObject {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");

    switch (request.method) {
      case "POST":
        if (path === "" || path === "/task") {
          const payload = (await request.json()) as DurableTaskPayload;
          const task = await this.startTask(payload);
          return this.json(task, 201);
        }
        break;
      case "GET":
        if (path === "" || path === "/task") {
          const tasks = await this.listTasks();
          return this.json({ tasks });
        }
        if (path.startsWith("/task/")) {
          const id = path.replace("/task/", "");
          const task = await this.getTask(id);
          if (!task) {
            return this.json({ error: "Not found" }, 404);
          }
          return this.json(task);
        }
        break;
      case "DELETE":
        if (path.startsWith("/task/")) {
          const id = path.replace("/task/", "");
          const task = await this.getTask(id);
          if (!task) {
            return this.json({ error: "Not found" }, 404);
          }
          task.status = "cancelled";
          task.updatedAt = new Date().toISOString();
          await this.putTask(task);
          return this.json(task);
        }
        break;
      default:
        break;
    }

    return this.json({ error: "Unsupported request" }, 405);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const tasks = await this.listTasks();
    let nextRunAt: number | undefined;

    for (const task of tasks) {
      if (task.status === "running" && task.runAt <= now) {
        try {
          task.status = "completed";
          task.result = {
            message: `Operation ${task.operation} completed`,
            data: task.data ?? null,
          };
        } catch (error) {
          task.status = "failed";
          task.error = error instanceof Error ? error.message : String(error);
        }
        task.updatedAt = new Date().toISOString();
        await this.putTask(task);
      } else if (task.status === "running") {
        nextRunAt = nextRunAt ? Math.min(nextRunAt, task.runAt) : task.runAt;
      }
    }

    if (nextRunAt) {
      await this.state.storage.setAlarm(nextRunAt);
    }
  }

  private async startTask(payload: DurableTaskPayload): Promise<StoredTask> {
    const id = crypto.randomUUID();
    const durationMs = Math.max(100, Math.min(payload.durationMs ?? 1500, 60_000));
    const now = new Date();
    const runAt = Date.now() + durationMs;

    const task: StoredTask = {
      id,
      status: "running",
      operation: payload.operation,
      data: payload.data ?? null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      runAt,
      durationMs,
    };

    await this.putTask(task);
    await this.state.storage.setAlarm(runAt);
    return task;
  }

  private async listTasks(): Promise<StoredTask[]> {
    const entries = await this.state.storage.list<StoredTask>({ prefix: STORAGE_PREFIX });
    return [...entries.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private async getTask(id: string): Promise<StoredTask | null> {
    return (await this.state.storage.get<StoredTask>(`${STORAGE_PREFIX}${id}`)) ?? null;
  }

  private async putTask(task: StoredTask): Promise<void> {
    await this.state.storage.put(`${STORAGE_PREFIX}${task.id}`, task);
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
}
