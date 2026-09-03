import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ChatSessionMetadata, CorrectionAttempt, ExecutionResult, GitEvidence, PlanRevision, PlannerContext, PlannerPlan, PlannerTask, ReviewFinding, ReviewRecord, ReviewState, TaskStatus } from "./types.js";
import { normalizeReviewState } from "./review-state.js";
import { validateHerdrContract } from "./herdr-contract.js";

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

  async createTask(workspaceRoot: string, request: string, activeMethods: string[] = [], requestedExecutionMode: "single" | "herdr" = "single"): Promise<PlannerTask> {
    await this.init(); const now = new Date().toISOString();
    const task: PlannerTask = { id: randomUUID(), createdAt: now, updatedAt: now, workspaceRoot, request, activeMethods, requestedExecutionMode, status: "planning" };
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
      if (task.requestedExecutionMode === "herdr" && !plan.execution) throw new Error("Multi-agent plan must include a Herdr execution contract.");
      if (plan.execution) validateHerdrContract(plan.execution);
      if (plan.context?.methods.some((method) => !(task.activeMethods ?? []).includes(method))) throw new Error("Plan context includes method not active in Pi task snapshot.");
      const complete = { ...plan, submittedAt: new Date().toISOString() };
      const revision: PlanRevision = { revision: 1, plan: complete, targetId: task.chat?.targetId ?? "", ...(complete.context ? { context: complete.context } : {}), createdAt: complete.submittedAt };
      return { ...task, plan: complete, planRevisions: { currentRevision: 1, revisions: [revision] }, status: "plan_received" };
    }).then((task) => this.transition(task.id, "awaiting_approval"));
  }
  async submitPlanRevision(id: string, baseRevision: number, plan: Omit<PlannerPlan, "submittedAt">, feedback: string, context?: PlannerContext): Promise<PlannerTask> {
    return this.mutate(id, (task) => {
      if (!["plan_received", "awaiting_approval"].includes(task.status)) throw new Error("Plan revisions are only allowed before approval.");
      const revisions = task.planRevisions ?? (task.plan && task.chat?.targetId ? { currentRevision: 1, revisions: [{ revision: 1, plan: task.plan, targetId: task.chat.targetId, ...(task.plan.context ? { context: task.plan.context } : {}), createdAt: task.plan.submittedAt }] } : undefined);
      if (!revisions || revisions.currentRevision !== baseRevision) throw new Error(`Stale plan revision: expected ${revisions?.currentRevision ?? 1}, got ${baseRevision}`);
      if (!task.chat?.targetId) throw new Error("Cannot revise plan without planner target identity");
      const revision = revisions.currentRevision + 1;
      if (task.requestedExecutionMode === "herdr" && !plan.execution) throw new Error("Multi-agent revision must include a Herdr execution contract.");
      if (plan.execution) validateHerdrContract(plan.execution);
      if (plan.context?.methods.some((method) => !(task.activeMethods ?? []).includes(method))) throw new Error("Plan context includes method not active in Pi task snapshot.");
      const inheritedContext = context ?? task.plan?.context;
      const complete = { ...plan, submittedAt: new Date().toISOString(), ...(inheritedContext ? { context: inheritedContext } : {}) };
      const next: PlanRevision = { revision, plan: complete, targetId: task.chat.targetId, ...(inheritedContext ? { context: inheritedContext } : {}), createdAt: complete.submittedAt, feedback };
      return { ...task, plan: complete, planRevisions: { ...revisions, currentRevision: revision, revisions: [...revisions.revisions, next] } };
    });
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
      const revision = task.planRevisions?.currentRevision ?? 1;
      const fingerprint = createHash("sha256").update(JSON.stringify(task.plan)).digest("hex");
      const lockedRevision = task.planRevisions ? { planRevisions: { ...task.planRevisions, approvedRevision: revision, approvedPlanFingerprint: fingerprint } } : {};
      const workers = task.plan?.execution?.workers.map((worker) => ({ ...worker, state: "pending" as const, model: "openai-codex/gpt-5.6-luna" as const, thinkingLevel: "max" as const }));
      return this.writeUpdated({ ...task, ...lockedRevision, status: "executing", execution: {
        status: "running", startedAt, completedAt: "", summary: task.plan?.execution ? "Herdr multi-agent execution running." : "Pi agent execution running.",
        filesChanged: [], validations: [], deviations: [], remainingIssues: [], ...(workers ? { workers } : {})
      } });
    });
  }
  async saveExecution(id: string, result: ExecutionResult): Promise<PlannerTask> {
    return this.mutate(id, (task) => {
      if (result.status === "running") return { ...task, execution: result };
      const status = result.status === "completed" ? "execution_completed" : "execution_failed";
      if (task.status !== "executing") throw new Error(`Cannot save execution from status ${task.status}`);
      return { ...task, execution: result, status, review: { status: result.status === "completed" ? "awaiting_review" : "not_started", iteration: 0, semanticIteration: 0, attempt: 0, reviews: [] } };
    });
  }

  async captureGitEvidence(id: string, phase: "preExecution" | "postExecution", evidence: GitEvidence): Promise<PlannerTask> {
    return this.mutate(id, (task) => {
      if (phase === "preExecution") {
        if (task.gitEvidence?.preExecution) return task;
        return { ...task, gitEvidence: { ...task.gitEvidence, preExecution: evidence } };
      }
      const review = task.review;
      if (!review?.reviews.length) return { ...task, gitEvidence: { ...task.gitEvidence, postExecution: evidence } };
      const latest = review.reviews.at(-1)!;
      const reviews = [...review.reviews.slice(0, -1), { ...latest, evidence }];
      return { ...task, gitEvidence: { ...task.gitEvidence, postExecution: evidence }, review: { ...review, reviews } };
    });
  }

  async normalizeReview(id: string, maxIterations: number): Promise<PlannerTask> {
    return this.mutate(id, (task) => ({ ...task, review: normalizeReviewState(task.review, maxIterations).review }));
  }

  /** Begin review iteration n; semantic count comes only from persisted submit_review verdicts. */
  async startReview(id: string, maxIterations: number): Promise<PlannerTask> {
    return this.mutate(id, (task) => {
      if (task.status !== "execution_completed") throw new Error(`Review requires execution_completed, got ${task.status}`);
      let review: ReviewState = normalizeReviewState(task.review, maxIterations).review;
      // Legacy V2 bug could mark max after transport failures. Recover only when no semantic verdict exists.
      if (review.status === "max_iterations_reached" && review.reviews.length > 0 && review.reviews.every((record) => record.status === "failed")) {
        review = { ...review, status: "failed", iteration: 0, semanticIteration: 0, reviews: review.reviews.slice(-1) };
      }
      if (["approved", "max_iterations_reached", "scope_expansion_required"].includes(review.status)) throw new Error(`Review is terminal: ${review.status}`);
      const semanticIteration = review.semanticIteration ?? review.iteration ?? 0;
      const previous = review.reviews.at(-1);
      const retrying = review.status === "failed" && previous?.status === "failed";
      const iteration = semanticIteration + 1;
      const attempt = (review.attempt ?? 0) + 1;
      if (!["not_started", "awaiting_review", "failed", "correction_completed"].includes(review.status)) {
        throw new Error(`Cannot start review from review status ${review.status}`);
      }
      const record: ReviewRecord = { iteration, startedAt: new Date().toISOString(), status: "reviewing", findings: [] };
      const reviews = retrying ? [...review.reviews.slice(0, -1), record] : [...review.reviews, record];
      const { error: _error, ...cleanReview } = review;
      return { ...task, review: { ...cleanReview, status: "reviewing", iteration, semanticIteration, attempt, reviews } };
    });
  }

  /** submit_review write: terminal per iteration, validated, fail-closed. */
  async saveReviewResult(id: string, iteration: number, status: "approved" | "changes_requested", summary: string, findings: ReviewFinding[]): Promise<PlannerTask> {
    return this.mutate(id, (task) => {
      const review = task.review;
      if (!review) throw new Error(`Task ${id} has no review in progress`);
      const record = review.reviews.at(-1);
      if (!record || record.status !== "reviewing") throw new Error("No review awaiting submission");
      if (record.iteration !== iteration) throw new Error(`Iteration mismatch: expected ${record.iteration}, got ${iteration}`);
      if (status === "approved" && findings.some((finding) => finding.severity === "blocking")) throw new Error("APPROVED review cannot contain blocking findings");
      if (status === "changes_requested" && findings.length === 0) throw new Error("CHANGES_REQUESTED review requires at least one finding");
      if (status === "approved" && findings.some((finding) => finding.scopeExpansionRequired)) throw new Error("APPROVED review cannot require scope expansion");
      const completed: ReviewRecord = { ...record, status, summary, findings, completedAt: new Date().toISOString() };
      const reviews = [...review.reviews.slice(0, -1), completed];
      const { error: _error, ...cleanReview } = review;
      return { ...task, review: { ...cleanReview, status, iteration, semanticIteration: Math.max(review.semanticIteration ?? 0, iteration), reviews } };
    });
  }

  async failReview(id: string, error: string): Promise<PlannerTask> {
    return this.mutate(id, (task) => {
      const review = task.review ?? { status: "not_started" as const, iteration: 0, reviews: [] };
      if (["approved", "changes_requested", "max_iterations_reached", "scope_expansion_required"].includes(review.status)) return task;
      const record = review.reviews.at(-1);
      const reviews = record && record.status === "reviewing"
        ? [...review.reviews.slice(0, -1), { ...record, status: "failed" as const, error, completedAt: new Date().toISOString() }]
        : review.reviews;
      const kind: import("./types.js").ReviewError["kind"] = error.startsWith("planner_target_unavailable") ? "planner_target_unavailable" : error.startsWith("infrastructure_not_ready") ? "infrastructure_not_ready" : error.startsWith("review_timeout") ? "review_timeout" : error.startsWith("mcp_unavailable") ? "mcp_unavailable" : "browser_transport_failure";
      return { ...task, review: { ...review, status: "failed", iteration: review.semanticIteration ?? 0, error: { kind, message: error, occurredAt: new Date().toISOString() }, reviews } };
    });
  }

  /** Development recovery for pre-V2 retry bug: only failed attempts, no semantic submissions. */
  async recoverOperationalReview(id: string): Promise<PlannerTask> {
    return this.mutate(id, (task) => {
      const review = task.review;
      if (!review || review.status !== "max_iterations_reached" || review.reviews.some((record) => record.status !== "failed")) {
        throw new Error("Unsafe review recovery: state contains a semantic review or is not max_iterations_reached");
      }
      return { ...task, review: { ...review, status: "failed", iteration: 0, semanticIteration: 0, reviews: review.reviews.slice(-1) } };
    });
  }

  async markMaxIterationsReached(id: string): Promise<PlannerTask> {
    return this.mutate(id, (task) => {
      if (task.review?.status !== "changes_requested") throw new Error(`Cannot stop iterations from review status ${task.review?.status}`);
      return { ...task, review: { ...task.review, status: "max_iterations_reached" } };
    });
  }

  /** Atomic correction claim: exactly one dispatch per changes_requested transition. */
  async claimCorrection(id: string, attempt?: Omit<CorrectionAttempt, "attemptId" | "status">): Promise<PlannerTask | undefined> {
    return this.withLock(async () => {
      const task = await this.getTask(id);
      if (task.review?.status !== "changes_requested" || task.correctionAttempt?.status === "claimed" || task.correctionAttempt?.status === "dispatched") return undefined;
      if (!attempt) return undefined;
      const correctionAttempt: CorrectionAttempt = { ...attempt, attemptId: randomUUID(), status: "claimed" };
      return this.writeUpdated({ ...task, correctionAttempt, review: { ...task.review, status: "correction_executing" } });
    });
  }

  async markCorrectionDispatched(id: string): Promise<PlannerTask> {
    return this.mutate(id, (task) => {
      if (task.review?.status !== "correction_executing" || task.correctionAttempt?.status !== "claimed") throw new Error("Correction attempt is not claimable for dispatch.");
      return { ...task, correctionAttempt: { ...task.correctionAttempt, status: "dispatched" } };
    });
  }

  async recoverInterruptedCorrections(): Promise<PlannerTask[]> {
    const tasks = await this.listTasks(); const recovered: PlannerTask[] = [];
    for (const task of tasks) {
      if (task.review?.status !== "correction_executing" || !task.correctionAttempt) continue;
      recovered.push(await this.mutate(task.id, (current) => ({ ...current, correctionAttempt: { ...current.correctionAttempt!, status: "ambiguous" }, review: { ...current.review!, status: "failed", error: { kind: "other" as const, message: "Correction interrupted; inspect workspace before retrying.", occurredAt: new Date().toISOString() } } })));
    }
    return recovered;
  }

  async retryFailedCorrection(id: string): Promise<PlannerTask> {
    return this.mutate(id, (task) => {
      const review = task.review; const record = review?.reviews.at(-1);
      if (!review || review.status !== "failed" || record?.correction?.status !== "failed") throw new Error("No failed correction awaiting retry");
      return { ...task, review: { ...review, status: "changes_requested" } };
    });
  }

  async saveCorrectionResult(id: string, result: ExecutionResult): Promise<PlannerTask> {
    return this.mutate(id, (task) => {
      if (task.review?.status !== "correction_executing") throw new Error(`Cannot save correction from review status ${task.review?.status}`);
      const record = task.review.reviews.at(-1);
      const scopeBlocked = record?.findings.some((finding) => finding.scopeExpansionRequired) === true
        || result.remainingIssues.some((issue) => issue.startsWith("scope:"));
      const attempt = task.correctionAttempt;
      const candidate = result.correctionAttempt;
      const turn = candidate?.herdrTurn;
      const herdrProofValid = attempt?.route !== "herdr-worker" || Boolean(candidate && turn && candidate.workerId === attempt.workerId && candidate.agentHandle === attempt.agentHandle && candidate.paneId === attempt.paneId && turn.agentHandle === attempt.agentHandle && turn.paneId === attempt.paneId && turn.turnObserved === true && turn.prompt.exitCode === 0 && turn.after?.name === attempt.agentHandle && turn.after?.paneId === attempt.paneId);
      const proofValid = Boolean(attempt && result.correctionAttemptId === attempt.attemptId && result.round === attempt.round && candidate?.attemptId === attempt.attemptId && candidate.route === attempt.route && candidate.proof?.attemptId === attempt.attemptId && candidate.proof.round === attempt.round && candidate.proof.route === attempt.route && candidate.proof.matched === true && candidate.status === "completed" && candidate.scopeEvidence && candidate.scopeEvidence.unownedFiles.length === 0 && candidate.scopeEvidence.ambiguousOwnerFiles.length === 0 && candidate.correctionRoundBaseline && herdrProofValid);
      if (result.status === "completed" && !proofValid) throw new Error("Correction completion proof missing or does not match current attempt.");
      const nextStatus = scopeBlocked ? "scope_expansion_required" : result.status === "failed" ? "failed" : "correction_completed";
      const reviews = record
        ? [...task.review.reviews.slice(0, -1), { ...record, correction: result }]
        : task.review.reviews;
      const execution = task.execution && (result.baseline || result.scopeEvidence)
        ? { ...task.execution, ...(result.baseline ? { baseline: result.baseline } : {}), filesChanged: result.filesChanged, deviations: result.deviations, remainingIssues: result.remainingIssues, ...(result.scopeEvidence ? { scopeEvidence: result.scopeEvidence } : {}) }
        : task.execution;
      const persistedAttempt = attempt && result.correctionAttempt
        ? { ...attempt, ...result.correctionAttempt, status: nextStatus === "correction_completed" ? "completed" as const : "failed" as const }
        : attempt;
      return { ...task, ...(execution ? { execution } : {}), ...(persistedAttempt ? { correctionAttempt: persistedAttempt } : {}), review: { ...task.review, status: nextStatus, reviews } };
    });
  }
  async pendingReviewTasks(): Promise<PlannerTask[]> {
    return (await this.listTasks()).filter((task) => task.status === "execution_completed" && ["awaiting_review", "reviewing", "changes_requested", "correction_completed"].includes(task.review?.status ?? ""));
  }

  async markReviewTargetClosed(): Promise<PlannerTask[]> {
    const pending = await this.pendingReviewTasks();
    const closed: PlannerTask[] = [];
    for (const task of pending) {
      closed.push(await this.mutate(task.id, (current) => {
        const review = current.review;
        if (!review || !["awaiting_review", "reviewing", "changes_requested", "correction_executing", "correction_completed"].includes(review.status)) return current;
        const error = { kind: "planner_target_closed" as const, message: "Original Temporary Chat is no longer available because Pi closed its planner Dia target.", occurredAt: new Date().toISOString() };
        const latest = review.reviews.at(-1);
        const reviews = latest?.status === "reviewing"
          ? [...review.reviews.slice(0, -1), { ...latest, status: "failed" as const, error: error.message, completedAt: error.occurredAt }]
          : review.reviews;
        return { ...current, review: { ...review, status: "failed", iteration: review.semanticIteration ?? 0, error, reviews } };
      }));
    }
    return closed;
  }

  async recoverInterruptedExecutions(): Promise<PlannerTask[]> {
    const tasks = await this.listTasks();
    const recovered: PlannerTask[] = [];
    for (const task of tasks) {
      if (task.status !== "executing") continue;
      recovered.push(await this.mutate(task.id, (current) => ({ ...current, status: "execution_failed", error: "Execution interrupted while workers were starting/running; inspect workspace before retrying.", ...(current.execution ? { execution: { ...current.execution, status: "failed" as const, completedAt: new Date().toISOString(), summary: "Execution needs attention: worker state is ambiguous after Pi restart.", error: "worker_lifecycle_ambiguous" } } : {}) })));
    }
    return recovered;
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
