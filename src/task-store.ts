import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ChatSessionMetadata, ExecutionResult, PlannerPlan, PlannerTask, TaskStatus } from "./types.js";

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  planning: ["plan_received", "execution_failed"],
  plan_received: ["awaiting_approval"],
  awaiting_approval: ["approved", "rejected"],
  approved: ["executing"],
  rejected: [], executing: ["execution_completed", "execution_failed"],
  execution_completed: [], execution_failed: []
};

export class TaskStore {
  readonly tasksDir: string;
  private lock = Promise.resolve();
  constructor(stateDir: string) { this.tasksDir = join(stateDir, "tasks"); }
  async init(): Promise<void> { await mkdir(this.tasksDir, { recursive: true }); }

  async createTask(workspaceRoot: string, request: string): Promise<PlannerTask> {
    await this.init(); const now = new Date().toISOString();
    const task: PlannerTask = { id: randomUUID(), createdAt: now, updatedAt: now, workspaceRoot, request, status: "planning" };
    await this.writeTask(task); return task;
  }
  async getTask(id: string): Promise<PlannerTask> { const raw = await readFile(this.pathFor(id), "utf8"); return JSON.parse(raw) as PlannerTask; }
  async listTasks(): Promise<PlannerTask[]> {
    await this.init(); const names = (await readdir(this.tasksDir)).filter((n) => n.endsWith(".json"));
    const tasks = await Promise.all(names.map(async (n) => JSON.parse(await readFile(join(this.tasksDir, n), "utf8")) as PlannerTask));
    return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async updateChat(id: string, chat: ChatSessionMetadata): Promise<PlannerTask> {
    return this.mutate(id, (task) => ({ ...task, chat }));
  }
  async submitPlan(id: string, plan: Omit<PlannerPlan, "submittedAt">): Promise<PlannerTask> {
    return this.mutate(id, (task) => {
      if (task.status !== "planning") throw new Error(`Cannot submit plan from status ${task.status}`);
      return { ...task, plan: { ...plan, submittedAt: new Date().toISOString() }, status: "plan_received" };
    }).then((task) => this.transition(task.id, "awaiting_approval"));
  }
  async transition(id: string, next: TaskStatus): Promise<PlannerTask> {
    return this.mutate(id, (task) => {
      if (!transitions[task.status].includes(next)) throw new Error(`Invalid task transition: ${task.status} -> ${next}`);
      return { ...task, status: next };
    });
  }
  async claimExecution(id: string): Promise<PlannerTask | undefined> {
    return this.withLock(async () => {
      const task = await this.getTask(id);
      if (task.status !== "approved") return undefined;
      const startedAt = new Date().toISOString();
      return this.writeUpdated({ ...task, status: "executing", execution: {
        status: "running", startedAt, completedAt: "", summary: "Pi agent execution running.",
        filesChanged: [], validations: [], deviations: [], remainingIssues: []
      } });
    });
  }
  async saveExecution(id: string, result: ExecutionResult): Promise<PlannerTask> {
    return this.mutate(id, (task) => {
      if (result.status === "running") return { ...task, execution: result };
      const status = result.status === "completed" ? "execution_completed" : "execution_failed";
      if (task.status !== "executing") throw new Error(`Cannot save execution from status ${task.status}`);
      return { ...task, execution: result, status };
    });
  }
  async failTask(id: string, error: string): Promise<PlannerTask> {
    return this.mutate(id, (task) => {
      if (task.status === "planning") return { ...task, status: "execution_failed", error };
      throw new Error(`Cannot fail task from status ${task.status}`);
    });
  }
  async waitForPlan(id: string, timeoutMs: number, signal?: AbortSignal): Promise<PlannerTask> {
    const started = Date.now();
    while (true) {
      if (signal?.aborted) throw new Error("Planning wait cancelled");
      const task = await this.getTask(id);
      if (["awaiting_approval", "approved", "executing", "execution_completed", "execution_failed", "rejected"].includes(task.status)) return task;
      if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for ChatGPT plan after ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  private async mutate(id: string, fn: (task: PlannerTask) => PlannerTask): Promise<PlannerTask> { return this.withLock(async () => this.writeUpdated(fn(await this.getTask(id)))); }
  private async writeUpdated(task: PlannerTask): Promise<PlannerTask> { const next = { ...task, updatedAt: new Date().toISOString() }; await this.writeTask(next); return next; }
  private async withLock<T>(fn: () => Promise<T>): Promise<T> { const previous = this.lock; let release!: () => void; this.lock = new Promise((r) => { release = r; }); await previous; try { return await fn(); } finally { release(); } }
  private pathFor(id: string): string { if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid task id"); return join(this.tasksDir, `${id}.json`); }
  private async writeTask(task: PlannerTask): Promise<void> { const target = this.pathFor(task.id); const tmp = `${target}.${process.pid}.${Date.now()}.tmp`; await writeFile(tmp, `${JSON.stringify(task, null, 2)}\n`, "utf8"); await rename(tmp, target); }
}
