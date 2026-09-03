import type { PlannerConfig, PlannerTask } from "../types.js";
import { TaskStore } from "../task-store.js";
import { PlannerMcpHttpServer } from "../mcp/server.js";
import { ChatGptBrowserController, type BrowserSendResult } from "../browser/chatgpt.js";
import { PiMessageExecutor, type PlannerExecutor } from "../executor.js";
import { PlannerInfrastructureManager, type InfrastructureDependency, type PlannerInfrastructureStatus, type ResourceState } from "./infrastructure.js";
import { SecureTunnel } from "./tunnel.js";
import { PlannerDia } from "./dia.js";
import { ReviewOrchestrator } from "./review.js";

import { captureWorkspaceBaseline, gitDiff, gitStatus } from "../workspace/git.js";

async function safeGit(fn: () => Promise<string>): Promise<string> {
  try { return await fn(); } catch { return ""; }
}

export class PlannerRuntime {
  readonly store: TaskStore;
  readonly mcp: PlannerMcpHttpServer;
  readonly browser: ChatGptBrowserController;
  private readonly executors = new Map<string, PlannerExecutor>();
  readonly infrastructure: PlannerInfrastructureManager;
  readonly tunnel: SecureTunnel;
  readonly dia: PlannerDia;
  private recoveredInterrupted = false;

  constructor(readonly config: PlannerConfig, private readonly executor?: PlannerExecutor) {
    this.store = new TaskStore(config.stateDir);
    this.mcp = new PlannerMcpHttpServer(this.store, config);
    this.browser = new ChatGptBrowserController(config);
    this.tunnel = new SecureTunnel(config);
    this.dia = new PlannerDia(config);
    const mcpDependency: InfrastructureDependency = {
      probe: async (): Promise<ResourceState> => (this.mcp.running ? "ready" : "stopped"),
      ensureStarted: async () => { await this.mcp.start(); return "ready"; },
      get managedByPi() { return true; },
      stop: () => this.mcp.stop()
    };
    this.infrastructure = new PlannerInfrastructureManager(mcpDependency, this.tunnel, this.dia);
    this.reviews = new ReviewOrchestrator({
      store: this.store,
      browser: this.browser,
      getExecutor: (taskId) => this.executors.get(taskId) ?? this.executor,
      isInfrastructureReady: async () => (await this.infrastructure.snapshot()).ready,
      maxReviewIterations: config.maxReviewIterations,
      reviewTimeoutMs: config.reviewTimeoutMs
    });
  }

  readonly reviews: ReviewOrchestrator;

  async approveTask(id: string, executor = this.executor): Promise<PlannerTask> {
    const current = await this.store.getTask(id);
    if (["approved", "executing", "execution_completed", "execution_failed"].includes(current.status)) return current;
    const approved = await this.store.transition(id, "approved");
    const claimed = await this.store.claimExecution(id);
    if (!claimed) return approved;
    if (executor) this.executors.set(id, executor);
    await this.store.captureGitEvidence(id, "preExecution", { capturedAt: new Date().toISOString(), gitStatus: await safeGit(() => gitStatus(claimed.workspaceRoot)), gitDiff: await safeGit(() => gitDiff(claimed.workspaceRoot, false)) });
    if (!executor) throw new Error("No Pi executor configured");
    try {
      const executionBaseline = await captureWorkspaceBaseline(claimed.workspaceRoot);
      const result = await executor.execute({ taskId: claimed.id, request: claimed.request, plan: claimed.plan!, workspaceRoot: claimed.workspaceRoot, executionBaseline, ...(claimed.planRevisions?.approvedRevision ? { approvedRevision: claimed.planRevisions.approvedRevision } : {}), onLifecycle: async (execution) => { await this.store.saveExecution(id, execution); }, instructions: "Follow project AGENTS.md instructions." });
      if (executor instanceof PiMessageExecutor) return this.store.getTask(id); // event handler persists correlated result
      await this.store.captureGitEvidence(id, "postExecution", { capturedAt: new Date().toISOString(), source: "pi", authoritative: true, gitStatus: await safeGit(() => gitStatus(claimed.workspaceRoot)), gitDiff: await safeGit(() => gitDiff(claimed.workspaceRoot, false)) });
      const saved = await this.store.saveExecution(id, result);
      if (saved.status === "execution_completed") this.reviews.beginReviewSafely(id);
      return saved;
    } catch (error) {
      if (executor instanceof PiMessageExecutor) return this.store.getTask(id); // event handler persists correlated failure
      const now = new Date().toISOString();
      return this.store.saveExecution(id, { status: "failed", startedAt: claimed.updatedAt, completedAt: now, summary: "Execution failed.", filesChanged: [], validations: [], deviations: [], remainingIssues: [], error: error instanceof Error ? error.message : String(error) });
    }
  }

  async adjustPlan(id: string, feedback: string): Promise<PlannerTask> {
    const task = await this.store.getTask(id);
    if (!["plan_received", "awaiting_approval"].includes(task.status)) throw new Error("Plan revisions are only allowed before approval. Create a follow-up planning task for additional scope.");
    const baseRevision = task.planRevisions?.currentRevision ?? 1;
    await this.browser.sendPlanRevisionPrompt(task, feedback, baseRevision);
    const deadline = Date.now() + this.config.planTimeoutMs;
    while (Date.now() < deadline) {
      const current = await this.store.getTask(id);
      if ((current.planRevisions?.currentRevision ?? 1) > baseRevision) return current;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Timed out waiting for plan revision ${baseRevision + 1}.`);
  }

  async rejectTask(id: string): Promise<PlannerTask> {
    const current = await this.store.getTask(id);
    if (current.status === "rejected") return current;
    return this.store.transition(id, "rejected");
  }

  async start(): Promise<void> {
    // Lazy minimal start (local MCP only); full tunnel+Dia startup is /chatgpt-planner-start.
    if (!this.recoveredInterrupted) { await this.store.recoverInterruptedExecutions(); await this.store.recoverInterruptedCorrections(); this.recoveredInterrupted = true; }
    await this.mcp.start();
  }

  async startInfrastructure(onProgress?: (message: string) => void): Promise<PlannerInfrastructureStatus> {
    await this.mcp.start();
    return this.infrastructure.start(onProgress);
  }

  async pendingReviewTasks(): Promise<PlannerTask[]> {
    return this.store.pendingReviewTasks();
  }

  async stop(): Promise<PlannerInfrastructureStatus> {
    if (this.dia.managedByPi) await this.store.markReviewTargetClosed();
    return this.infrastructure.stopOwnedResources();
  }

  async infraSnapshot(): Promise<PlannerInfrastructureStatus> {
    return this.infrastructure.snapshot();
  }

  async debugBrowser(): Promise<{ path: string; report: unknown }> {
    await this.start();
    return this.browser.debugPlannerTab();
  }

  executionPromptMatches(prompt: string): boolean {
    for (const executor of this.executors.values()) {
      if (executor instanceof PiMessageExecutor && executor.matchesPrompt(prompt)) return true;
    }
    return false;
  }

  async handleAgentEnd(messages: unknown[]): Promise<void> {
    for (const [taskId, executor] of this.executors) {
      if (!(executor instanceof PiMessageExecutor)) continue;
      const result = await executor.complete(messages);
      if (!result) continue;
      if (result.round) return; // correction promise persists through ReviewOrchestrator
      const current = await this.store.getTask(taskId);
      await this.store.captureGitEvidence(taskId, "postExecution", { capturedAt: new Date().toISOString(), source: "pi", authoritative: true, gitStatus: await safeGit(() => gitStatus(current.workspaceRoot)), gitDiff: await safeGit(() => gitDiff(current.workspaceRoot, false)) });
      const saved = await this.store.saveExecution(taskId, result);
      if (saved.status === "execution_completed") this.reviews.beginReviewSafely(taskId);
      return;
    }
  }

  async handleAgentFailure(error: unknown): Promise<void> {
    for (const [taskId, executor] of this.executors) {
      if (!(executor instanceof PiMessageExecutor)) continue;
      const result = executor.fail(error);
      if (!result) continue;
      if (result.round) return; // correction promise persists through ReviewOrchestrator
      await this.store.saveExecution(taskId, result);
      return;
    }
  }

  async createAndSendTask(workspaceRoot: string, request: string, activeMethods: string[] = [], requestedExecutionMode: "single" | "herdr" = "single"): Promise<{
    task: PlannerTask;
    browser: BrowserSendResult;
  }> {
    await this.start();
    const task = await this.store.createTask(workspaceRoot, request, activeMethods, requestedExecutionMode);
    try {
      const browser = await this.browser.sendPlanningRequest(task, async (targetId) => {
        // Persist target identity before any page setup or prompt submission.
        await this.store.updateChat(task.id, {
          targetId,
          temporary: false,
          personalized: false,
          reasoning: "unknown"
        });
      });
      await this.store.updateChat(task.id, browser.chat);
      return { task: await this.store.getTask(task.id), browser };
    } catch (error) {
      await this.store.failTask(task.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}
