import { gitStatus } from "./workspace/git.js";
import type { PlannerPlan, ExecutionResult } from "./types.js";

export interface PlannerExecutorInput {
  taskId: string;
  request: string;
  plan: PlannerPlan;
  workspaceRoot: string;
  instructions: string;
}

export interface PlannerExecutor {
  execute(input: PlannerExecutorInput): Promise<ExecutionResult>;
}

export function executionInstruction(input: PlannerExecutorInput): string {
  return `Implement approved plan for task ${input.taskId}.\n\nStay within approved scope. You may edit files and run local commands/tests required to implement and validate plan. Do not commit, push, deploy, publish, or modify unrelated files. If plan cannot be followed exactly, make smallest safe deviation and report it.\n\nOriginal request:\n${input.request}\n\nApproved plan:\n${input.plan.planMarkdown}\n\nProject instructions:\n${input.instructions}\n\nAt completion return implementation summary, files changed, validations/tests run, validation results, deviations, and remaining issues/errors.`;
}

export class PiMessageExecutor implements PlannerExecutor {
  private pending: { marker: string; input: PlannerExecutorInput; startedAt: string; started: boolean; resolve: (result: ExecutionResult) => void; reject: (error: Error) => void } | undefined;
  constructor(private readonly send: (message: string) => void) {}

  execute(input: PlannerExecutorInput): Promise<ExecutionResult> {
    if (this.pending) return Promise.reject(new Error("Pi execution already active"));
    const marker = `PI_PLANNER_EXECUTION_${input.taskId}_${Date.now()}`;
    const startedAt = new Date().toISOString();
    return new Promise((resolve, reject) => {
      this.pending = { marker, input, startedAt, started: false, resolve, reject };
      try { this.send(`${executionInstruction(input)}\n\nExecution correlation: ${marker}`); }
      catch (error) { this.pending = undefined; reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  matchesPrompt(prompt: string): boolean {
    if (!this.pending || !prompt.includes(this.pending.marker)) return false;
    this.pending.started = true;
    return true;
  }

  async complete(messages: unknown[]): Promise<ExecutionResult | undefined> {
    const pending = this.pending;
    if (!pending || !pending.started) return undefined;
    this.pending = undefined;
    let filesChanged: string[] = [];
    try { filesChanged = (await gitStatus(pending.input.workspaceRoot)).split("\n").slice(1).map((line) => line.slice(3).trim()).filter(Boolean); } catch { /* non-git workspace */ }
    const summary = messages.map((message) => typeof (message as { content?: unknown }).content === "string" ? (message as { content: string }).content : "").filter(Boolean).at(-1) ?? "Pi agent execution completed.";
    const result: ExecutionResult = { status: "completed", startedAt: pending.startedAt, completedAt: new Date().toISOString(), summary, filesChanged, validations: [], deviations: [], remainingIssues: [] };
    pending.resolve(result);
    return result;
  }

  fail(error: unknown): ExecutionResult | undefined {
    const pending = this.pending;
    if (!pending || !pending.started) return undefined;
    this.pending = undefined;
    const result: ExecutionResult = { status: "failed", startedAt: pending.startedAt, completedAt: new Date().toISOString(), summary: "Pi agent execution failed.", filesChanged: [], validations: [], deviations: [], remainingIssues: [], error: error instanceof Error ? error.message : String(error) };
    pending.resolve(result);
    return result;
  }
}
