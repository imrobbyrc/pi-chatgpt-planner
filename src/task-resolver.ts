import type { PlannerTask } from "./types.js";
import type { TaskStore } from "./task-store.js";

export type TaskCommand = "status" | "approve" | "reject" | "review" | "recover" | "adjust";

export function taskShortId(task: PlannerTask): string { return task.id.slice(0, 8); }
export function taskTitle(task: PlannerTask): string { return (task.plan?.summary ?? task.request).replace(/\s+/g, " ").trim().slice(0, 72); }

export function taskValidFor(task: PlannerTask, command: TaskCommand): boolean {
  if (command === "status") return true;
  if (command === "approve" || command === "adjust") return command === "approve" ? ["awaiting_approval", "plan_received"].includes(task.status) : ["plan_received", "awaiting_approval"].includes(task.status);
  if (command === "reject") return ["plan_received", "awaiting_approval"].includes(task.status);
  if (command === "review") return task.status === "execution_completed" && ["awaiting_review", "reviewing", "failed", "changes_requested", "correction_completed"].includes(task.review?.status ?? "");
  return task.status === "execution_completed" && ["failed", "max_iterations_reached"].includes(task.review?.status ?? "");
}

export class TaskResolver {
  private currentId: string | undefined;
  constructor(private readonly store: TaskStore) {}
  setCurrent(task: PlannerTask | string): void { this.currentId = typeof task === "string" ? task : task.id; }
  get current(): string | undefined { return this.currentId; }

  async resolve(command: TaskCommand, explicitId?: string): Promise<PlannerTask> {
    const tasks = await this.store.listTasks();
    if (explicitId) {
      const matches = tasks.filter((task) => task.id === explicitId || task.id.startsWith(explicitId));
      if (!matches.length) throw new Error(`Unknown planner task "${explicitId}".`);
      if (matches.length > 1) throw new Error(`Ambiguous planner task "${explicitId}": ${matches.map(taskShortId).join(", ")}`);
      const task = matches[0]!;
      if (!taskValidFor(task, command)) throw new Error(`Task ${taskShortId(task)} is not valid for ${command}.`);
      this.setCurrent(task); return task;
    }
    const current = this.currentId ? tasks.find((task) => task.id === this.currentId) : undefined;
    if (current && taskValidFor(current, command)) return current;
    const candidates = tasks.filter((task) => taskValidFor(task, command));
    if (candidates.length === 1) { this.setCurrent(candidates[0]!); return candidates[0]!; }
    if (!candidates.length) throw new Error(`No planner task available for ${command}. Use /chatgpt-plan first.`);
    throw new Error(`Multiple planner tasks available for ${command}: ${candidates.map((task) => `${taskShortId(task)} ${taskTitle(task)}`).join("; ")}. Use /chatgpt-plan-list or provide a task ID.`);
  }

  async list(limit = 15): Promise<PlannerTask[]> { return (await this.store.listTasks()).slice(0, limit); }
}
