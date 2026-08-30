import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ChatSessionMetadata, PlannerPlan, PlannerTask } from "./types.js";

export class TaskStore {
  readonly tasksDir: string;

  constructor(stateDir: string) {
    this.tasksDir = join(stateDir, "tasks");
  }

  async init(): Promise<void> {
    await mkdir(this.tasksDir, { recursive: true });
  }

  async createTask(workspaceRoot: string, request: string): Promise<PlannerTask> {
    await this.init();
    const now = new Date().toISOString();
    const task: PlannerTask = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      workspaceRoot,
      request,
      status: "pending_planning"
    };
    await this.writeTask(task);
    return task;
  }

  async getTask(id: string): Promise<PlannerTask> {
    const path = this.pathFor(id);
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as PlannerTask;
  }

  async listTasks(): Promise<PlannerTask[]> {
    await this.init();
    const names = (await readdir(this.tasksDir)).filter((name) => name.endsWith(".json"));
    const tasks = await Promise.all(
      names.map(async (name) => {
        const raw = await readFile(join(this.tasksDir, name), "utf8");
        return JSON.parse(raw) as PlannerTask;
      })
    );
    return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async updateChat(id: string, chat: ChatSessionMetadata): Promise<PlannerTask> {
    const task = await this.getTask(id);
    const next = { ...task, updatedAt: new Date().toISOString(), chat };
    await this.writeTask(next);
    return next;
  }

  async submitPlan(id: string, plan: Omit<PlannerPlan, "submittedAt">): Promise<PlannerTask> {
    const task = await this.getTask(id);
    if (task.status === "cancelled") {
      throw new Error(`Task ${id} is cancelled`);
    }

    const now = new Date().toISOString();
    const next: PlannerTask = {
      ...task,
      updatedAt: now,
      status: "plan_received",
      plan: {
        ...plan,
        submittedAt: now
      }
    };
    await this.writeTask(next);
    return next;
  }

  async failTask(id: string, error: string): Promise<PlannerTask> {
    const task = await this.getTask(id);
    const next: PlannerTask = {
      ...task,
      updatedAt: new Date().toISOString(),
      status: "failed",
      error
    };
    await this.writeTask(next);
    return next;
  }

  async waitForPlan(
    id: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<PlannerTask> {
    const startedAt = Date.now();
    while (true) {
      if (signal?.aborted) throw new Error("Planning wait cancelled");
      const task = await this.getTask(id);
      if (task.status === "plan_received") return task;
      if (task.status === "failed") throw new Error(task.error ?? "Planning failed");
      if (task.status === "cancelled") throw new Error("Planning task cancelled");
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for ChatGPT plan after ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  private pathFor(id: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      throw new Error("Invalid task id");
    }
    return join(this.tasksDir, `${id}.json`);
  }

  private async writeTask(task: PlannerTask): Promise<void> {
    const target = this.pathFor(task.id);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(task, null, 2)}\n`, "utf8");
    await rename(tmp, target);
  }
}
