import { gitDiff, gitStatus } from "../workspace/git.js";
import type { GitEvidence, PlannerTask } from "../types.js";
import { findingsSummary, reviewPromptFor, type PlannerExecutor } from "../executor.js";
import type { TaskStore } from "../task-store.js";
import type { ChatGptBrowserController } from "../browser/chatgpt.js";
import { correctionOwner, correctionRoute } from "../worker-routing.js";
import { captureWorkspaceBaseline, changedFilesFromBaseline } from "../workspace/git.js";

export interface ReviewDependencies {
  store: TaskStore;
  browser: ChatGptBrowserController;
  getExecutor: (taskId: string) => PlannerExecutor | undefined;
  isInfrastructureReady: () => Promise<boolean>;
  maxReviewIterations: number;
  reviewTimeoutMs: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function captureEvidence(workspaceRoot: string): Promise<GitEvidence> {
  const evidence: GitEvidence = { capturedAt: new Date().toISOString(), source: "review", authoritative: true, gitStatus: "", gitDiff: "" };
  try { evidence.gitStatus = await gitStatus(workspaceRoot); } catch { /* non-git workspace */ }
  try { evidence.gitDiff = await gitDiff(workspaceRoot, false); } catch { /* non-git workspace */ }
  return evidence;
}

/** V2 review loop: same-target review, bounded corrections, fail-closed everywhere. */
export class ReviewOrchestrator {
  private inFlight = new Map<string, Promise<void>>();

  constructor(private readonly deps: ReviewDependencies) {}

  /** Fire-and-forget entry: never throws into the caller's execution-completion path. */
  beginReviewSafely(taskId: string): void {
    if (this.inFlight.has(taskId)) return;
    const run = this.runReviewRound(taskId).catch(() => { /* persisted inside */ }).finally(() => this.inFlight.delete(taskId));
    this.inFlight.set(taskId, run);
  }

  /** Explicit retry (also used automatically). Operational failures persist review=failed. */
  async startReview(taskId: string): Promise<string> {
    if (this.inFlight.has(taskId)) return "review already in progress";
    const run = this.runReviewRound(taskId).then(() => "done").catch((error) => error instanceof Error ? error.message : String(error)).finally(() => this.inFlight.delete(taskId));
    this.inFlight.set(taskId, run.then(() => undefined, () => undefined));
    return run;
  }

  async retryReview(taskId: string): Promise<string> { return this.startReview(taskId); }

  private async runReviewRound(taskId: string): Promise<void> {
    const { store } = this.deps;
    let task = await store.getTask(taskId);
    if (task.status !== "execution_completed" || !task.plan) throw new Error(`Task ${taskId} is not execution_completed`);

    // Normalize legacy counters before terminal-state checks; only submit_review evidence is semantic.
    task = await store.normalizeReview(taskId, this.deps.maxReviewIterations);
    if (task.review?.error?.kind === "planner_target_closed") {
      throw new Error("Original Temporary Chat is no longer available. This task cannot be reviewed by the same planner conversation. Create a new planning task if review is still required.");
    }
    if (task.review?.status === "failed" && task.review.reviews.at(-1)?.correction?.status === "failed") {
      await store.retryFailedCorrection(taskId);
      await this.startCorrection(await store.getTask(taskId));
      return;
    }
    if (task.review?.status === "changes_requested") {
      await this.startCorrection(task);
      return;
    }
    if (["approved", "max_iterations_reached", "scope_expansion_required"].includes(task.review?.status ?? "")) {
      throw new Error(`Review is terminal: ${task.review?.status}`);
    }
    if (!(await this.deps.isInfrastructureReady())) {
      await store.failReview(taskId, "infrastructure_not_ready: start planner infrastructure before retrying review");
      throw new Error("planner infrastructure not ready");
    }

    task = await store.startReview(taskId, this.deps.maxReviewIterations);
    const review = task.review!;
    if (review.status === "max_iterations_reached") return; // bounded: stop, findings already persisted

    await store.captureGitEvidence(taskId, "postExecution", await captureEvidence(task.workspaceRoot));
    task = await store.getTask(taskId);
    const iteration = review.reviews.at(-1)!.iteration;
    const previous = iteration > 1 ? task.review?.reviews.at(-2) : undefined;

    try {
      const message = reviewPromptFor(taskId, iteration, previous && previous.findings.length ? findingsSummary(previous.findings) : undefined, task.plan?.context);
      await this.deps.browser.sendReviewPrompt(task, message); // same targetId
    } catch (error) {
      await store.failReview(taskId, error instanceof Error ? error.message : String(error));
      throw error;
    }

    // Wait for submit_review; timeout is an operational failure, never an approval.
    const deadline = Date.now() + this.deps.reviewTimeoutMs;
    while (Date.now() < deadline) {
      const current = await store.getTask(taskId);
      const latest = current.review?.reviews.at(-1);
      if (latest && latest.status !== "reviewing") {
        if (current.review?.status === "changes_requested") {
          await sleep(250); // allow ChatGPT's submit_review tool result to return before Pi sends correction
          await this.startCorrection(current);
        }
        return;
      }
      await sleep(1_000);
    }
    const timedOut = await store.getTask(taskId);
    if (timedOut.review?.reviews.at(-1)?.status !== "reviewing") {
      if (timedOut.review?.status === "changes_requested") await this.startCorrection(timedOut);
      return;
    }
    await store.failReview(taskId, `review_timeout: no submit_review within ${this.deps.reviewTimeoutMs}ms`);
    throw new Error("review timed out");
  }

  /** CHANGES_REQUESTED -> one Pi-local correction inside approved scope, then review again. */
  private async startCorrection(task: PlannerTask): Promise<void> {
    const { store } = this.deps;
    const round = task.review!.iteration;
    if (round >= this.deps.maxReviewIterations) {
      await store.markMaxIterationsReached(task.id);
      return;
    }
    const findings = task.review?.reviews.at(-1)?.findings ?? [];
    const route = task.plan?.execution ? correctionRoute(task.plan.execution.workers, findings) : { kind: "pi-lead" as const };
    const owner = route.kind === "worker" ? route.worker : undefined;
    const workerRecord = owner ? task.execution?.workers?.find((worker) => worker.id === owner.id) : undefined;
    const persistedHandle = workerRecord?.agentHandle ?? (workerRecord?.agentId && !workerRecord.agentId.startsWith("cli:") ? workerRecord.agentId : undefined);
    const reusable = Boolean(workerRecord?.state === "completed" && persistedHandle && workerRecord.paneId);
    const roundBaseline = await captureWorkspaceBaseline(task.workspaceRoot);
    const claimed = await store.claimCorrection(task.id, { round, route: route.kind === "worker" && reusable ? "herdr-worker" : "pi-lead", workerId: owner?.id ?? "", agentHandle: persistedHandle ?? "", paneId: workerRecord?.paneId ?? "", correctionRoundBaseline: roundBaseline });
    if (!claimed) return; // duplicate; correction already dispatched
    await store.captureGitEvidence(task.id, "preExecution", await captureEvidence(task.workspaceRoot));
    const executor = this.deps.getExecutor(task.id);
    if (!executor) {
      await store.saveCorrectionResult(task.id, failed(`No Pi executor configured for correction round ${round}`));
      throw new Error("no executor");
    }
    if (findings.some((finding) => finding.scopeExpansionRequired)) {
      const now = new Date().toISOString();
      await store.saveCorrectionResult(task.id, { status: "failed", startedAt: now, completedAt: now, summary: "Correction stopped before dispatch because review exceeds approved scope.", filesChanged: [], validations: [], deviations: [], remainingIssues: ["scope: review finding exceeds approved scope"], round, correctionAttemptId: claimed.correctionAttempt!.attemptId, correctionAttempt: { ...claimed.correctionAttempt!, status: "failed" } });
      return;
    }
    await store.markCorrectionDispatched(task.id);
    let result: import("../types.js").ExecutionResult;
    try {
      result = await executor.execute({
      taskId: task.id,
      request: task.request,
      plan: claimed.plan!,
      workspaceRoot: task.workspaceRoot,
      ...(claimed.execution?.baseline ? { executionBaseline: claimed.execution.baseline } : {}),
      ...(claimed.correctionAttempt?.attemptId ? { correctionAttemptId: claimed.correctionAttempt.attemptId } : {}),
      ...(claimed.planRevisions?.approvedRevision ? { approvedRevision: claimed.planRevisions.approvedRevision } : {}),
      ...(reusable ? { correctionWorkerId: owner!.id, correctionAgentHandle: persistedHandle!, correctionPaneId: workerRecord!.paneId, correctionObjective: owner!.objective, correctionOwnership: owner!.owns } : {}),
      round,
      instructions: `${owner ? `Unique approved owner: ${owner.id}. Reuse only if its exact Herdr context remains safely available; otherwise act as Pi Lead.\n\n` : "Pi Lead correction required: no unique safe worker owner.\n\n"}Reviewer findings:\n${findingsSummary(findings)}`
      });
    } catch (error) {
      result = failed(error instanceof Error ? error.message : String(error));
    }
    if (claimed.correctionAttempt && (!result.correctionAttempt || !result.correctionAttempt.scopeEvidence)) {
      const finalFiles = await changedFilesFromBaseline(task.workspaceRoot, claimed.execution?.baseline ?? claimed.correctionAttempt.correctionRoundBaseline!);
      const correctionAttempt = { ...(result.correctionAttempt ?? claimed.correctionAttempt), status: result.status === "completed" ? "completed" as const : "failed" as const, correctionFilesChanged: result.correctionAttempt?.correctionFilesChanged ?? finalFiles, correctionRoundBaseline: result.correctionAttempt?.correctionRoundBaseline ?? claimed.correctionAttempt.correctionRoundBaseline!, scopeEvidence: { changedFiles: finalFiles, unownedFiles: [], ambiguousOwnerFiles: [], ownersByFile: Object.fromEntries(finalFiles.map((file) => [file, []])) }, ...(result.status === "completed" && !result.correctionAttempt?.proof ? { proof: { route: claimed.correctionAttempt.route, attemptId: claimed.correctionAttempt.attemptId, round, matched: true } } : {}) };
      result = { ...result, filesChanged: finalFiles, correctionAttemptId: claimed.correctionAttempt.attemptId, correctionAttempt, ...(correctionAttempt.proof ? { proof: correctionAttempt.proof } : {}) };
    }
    await store.captureGitEvidence(task.id, "postExecution", await captureEvidence(task.workspaceRoot));
    await store.saveCorrectionResult(task.id, result);
    const updated = await store.getTask(task.id);
    if (updated.review?.status === "correction_completed") await this.runReviewRound(task.id);
  }
}

function failed(error: string): import("../types.js").ExecutionResult {
  const now = new Date().toISOString();
  return { status: "failed", startedAt: now, completedAt: now, summary: "Correction failed.", filesChanged: [], validations: [], deviations: [], remainingIssues: [], error };
}
