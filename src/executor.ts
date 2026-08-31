import { gitStatus } from "./workspace/git.js";
import type { ExecutionResult, PlannerPlan, ReviewFinding } from "./types.js";

export interface PlannerExecutorInput {
  taskId: string;
  request: string;
  plan: PlannerPlan;
  workspaceRoot: string;
  instructions: string;
  round?: number; // V2 correction round; 0/undefined = initial execution
}

export interface PlannerExecutor {
  execute(input: PlannerExecutorInput): Promise<ExecutionResult>;
}

/** Remaining-issue items prefixed with this require explicit user scope decision. */
export const SCOPE_PREFIX = "scope:";

export function executionInstruction(input: PlannerExecutorInput): string {
  if ((input.round ?? 0) > 0) {
    return [
      `Address the review findings for this already-approved task (${input.taskId}, correction round ${input.round}).`,
      "",
      "Stay strictly within the original approved scope. Do not introduce unrelated improvements.",
      "Do not commit, push, deploy, or publish. Inspect the actual workspace and implement",
      "only the corrections needed for the review findings.",
      "",
      `Original request:\n${input.request}`,
      "",
      `Approved plan:\n${input.plan.planMarkdown}`,
      input.plan.context ? `Approved planner context:\nMethods: ${input.plan.context.methods.join(", ") || "none"}\nSkills: ${input.plan.context.skills.join(", ") || "none"}` : "",
      "",
      input.instructions,
      "",
      "Run relevant validation where possible.",
      "",
      "Report: corrections made, files changed, validation results, any finding that could",
      `not safely be addressed, and any requested change that would exceed approved scope.`,
      `Prefix items that would exceed approved scope with "${SCOPE_PREFIX}" so Pi can surface them for an explicit user decision.`
    ].join("\n");
  }
  const context = input.plan.context ? `\n\nApproved planner context:\nMethods: ${input.plan.context.methods.join(", ") || "none"}\nSkills: ${input.plan.context.skills.join(", ") || "none"}` : "";
  return `Implement approved plan for task ${input.taskId}.${context}\n\nStay within approved scope. You may edit files and run local commands/tests required to implement and validate plan. Do not commit, push, deploy, publish, or modify unrelated files. If plan cannot be followed exactly, make smallest safe deviation and report it.\n\nOriginal request:\n${input.request}\n\nApproved plan:\n${input.plan.planMarkdown}\n\nProject instructions:\n${input.instructions}\n\nAt completion return implementation summary, files changed, validations/tests run, validation results, deviations, and remaining issues/errors.`;
}

export function findingsSummary(findings: ReviewFinding[]): string {
  return findings
    .map((finding) => `- [${finding.severity}]${finding.file ? ` ${finding.file}${finding.line ? `:${finding.line}` : ""}:` : ""} ${finding.issue}${finding.requested_change ? ` Requested: ${finding.requested_change}` : ""}`)
    .join("\n");
}

export function reviewPromptFor(taskId: string, iteration: number, previousFindings?: string, context?: { methods: string[]; skills: string[] }): string {
  const previous = previousFindings ? `\nPi has addressed your previous review findings (round ${iteration - 1}):\n${previousFindings}\n` : "";
  const approvedContext = context ? `\nApproved planner context for this review contract:\nMethods: ${context.methods.join(", ") || "none"}\nSkills: ${context.skills.join(", ") || "none"}\nEvaluate against this context; do not use later active state.` : "";
  return `You planned task ${taskId} earlier. Pi has now executed the approved plan.${approvedContext}\n\nReview the implementation using Pi Workspace. First call review_context for the exact task ${taskId}. Then inspect the actual workspace using git_status, git_diff, read_file, search_workspace, or repo_map as needed.\n\nCompare the implementation against: the original request, your approved plan, actual changed files, and execution evidence.\n\nDo not modify source. Do not expand the original scope. Ignore unrelated pre-existing workspace changes identified by review_context.\n\nSubmit exactly one structured review using submit_review for task ${taskId}, iteration ${iteration}.${previous}\nUse APPROVED only when the implementation satisfies the approved scope and has no concrete blocking correctness issue. Use CHANGES_REQUESTED when concrete changes are required. For every requested change provide specific evidence and an actionable fix. Set scope_expansion_required=true when a finding cannot be fixed without exceeding the original approved request/plan scope; Pi will stop for user action instead of expanding scope.`;
}

export class PiMessageExecutor implements PlannerExecutor {
  private pending: { marker: string; input: PlannerExecutorInput; startedAt: string; started: boolean; resolve: (result: ExecutionResult) => void; reject: (error: Error) => void } | undefined;

  constructor(private readonly send: (message: string) => void) {}

  execute(input: PlannerExecutorInput): Promise<ExecutionResult> {
    if (this.pending) return Promise.reject(new Error("Pi execution already active"));
    const round = input.round ?? 0;
    const marker = `PI_PLANNER_EXECUTION_${input.taskId}_r${round}_${Date.now()}`;
    const startedAt = new Date().toISOString();
    return new Promise((resolve, reject) => {
      this.pending = { marker, input, startedAt, started: false, resolve, reject };
      try {
        this.send(`${executionInstruction(input)}\n\nExecution correlation: ${marker}`);
      } catch (error) {
        this.pending = undefined;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
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
    try {
      filesChanged = (await gitStatus(pending.input.workspaceRoot)).split("\n").slice(1).map((line) => line.slice(3).trim()).filter(Boolean);
    } catch { /* non-git workspace */ }
    const summary = messages.map((message) => typeof (message as { content?: unknown }).content === "string" ? (message as { content: string }).content : "").filter(Boolean).at(-1) ?? "Pi agent execution completed.";
    const remainingIssues = (pending.input.round ?? 0) > 0 && /(?:^|\n)\s*scope:/im.test(summary)
      ? ["scope: correction agent reported required scope expansion; inspect execution summary"]
      : [];
    const result: ExecutionResult = { status: "completed", startedAt: pending.startedAt, completedAt: new Date().toISOString(), summary, filesChanged, validations: [], deviations: [], remainingIssues };
    if (pending.input.round !== undefined) result.round = pending.input.round;
    pending.resolve(result);
    return result;
  }

  fail(error: unknown): ExecutionResult | undefined {
    const pending = this.pending;
    if (!pending || !pending.started) return undefined;
    this.pending = undefined;
    const result: ExecutionResult = { status: "failed", startedAt: pending.startedAt, completedAt: new Date().toISOString(), summary: "Pi agent execution failed.", filesChanged: [], validations: [], deviations: [], remainingIssues: [], error: error instanceof Error ? error.message : String(error) };
    if (pending.input.round !== undefined) result.round = pending.input.round;
    pending.resolve(result);
    return result;
  }
}
