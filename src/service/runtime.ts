import type { PlannerConfig, PlannerTask } from "../types.js";
import { TaskStore } from "../task-store.js";
import { PlannerMcpHttpServer } from "../mcp/server.js";
import { ChatGptBrowserController, type BrowserSendResult } from "../browser/chatgpt.js";
import { PiMessageExecutor, type PlannerExecutor } from "../executor.js";
import { PlannerInfrastructureManager, type InfrastructureDependency, type PlannerInfrastructureStatus, type ResourceState } from "./infrastructure.js";
import { SecureTunnel } from "./tunnel.js";
import { PlannerDia } from "./dia.js";

export class PlannerRuntime {
  readonly store: TaskStore;
  readonly mcp: PlannerMcpHttpServer;
  readonly browser: ChatGptBrowserController;
  private activeExecutor: PlannerExecutor | undefined;
  readonly infrastructure: PlannerInfrastructureManager;
  readonly tunnel: SecureTunnel;
  readonly dia: PlannerDia;

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
  }

  async approveTask(id: string, executor = this.executor): Promise<PlannerTask> {
    this.activeExecutor = executor;
    const current = await this.store.getTask(id);
    if (["approved", "executing", "execution_completed", "execution_failed"].includes(current.status)) return current;
    const approved = await this.store.transition(id, "approved");
    const claimed = await this.store.claimExecution(id);
    if (!claimed) return approved;
    if (!executor) throw new Error("No Pi executor configured");
    try {
      const result = await executor.execute({ taskId: claimed.id, request: claimed.request, plan: claimed.plan!, workspaceRoot: claimed.workspaceRoot, instructions: "Follow project AGENTS.md instructions." });
      return this.store.saveExecution(id, result);
    } catch (error) {
      const now = new Date().toISOString();
      return this.store.saveExecution(id, { status: "failed", startedAt: claimed.updatedAt, completedAt: now, summary: "Execution failed.", filesChanged: [], validations: [], deviations: [], remainingIssues: [], error: error instanceof Error ? error.message : String(error) });
    }
  }

  async rejectTask(id: string): Promise<PlannerTask> {
    const current = await this.store.getTask(id);
    if (current.status === "rejected") return current;
    return this.store.transition(id, "rejected");
  }

  async start(): Promise<void> {
    // Lazy minimal start (local MCP only); full tunnel+Dia startup is /chatgpt-planner-start.
    await this.mcp.start();
  }

  async startInfrastructure(onProgress?: (message: string) => void): Promise<PlannerInfrastructureStatus> {
    await this.mcp.start();
    return this.infrastructure.start(onProgress);
  }

  async stop(): Promise<PlannerInfrastructureStatus> {
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
    return this.activeExecutor instanceof PiMessageExecutor && this.activeExecutor.matchesPrompt(prompt);
  }

  async handleAgentEnd(messages: unknown[]): Promise<void> {
    if (!(this.activeExecutor instanceof PiMessageExecutor)) return;
    const task = (await this.store.listTasks()).find((candidate) => candidate.status === "executing");
    if (!task) return;
    const result = await this.activeExecutor.complete(messages);
    if (result) await this.store.saveExecution(task.id, result);
  }

  async handleAgentFailure(error: unknown): Promise<void> {
    if (!(this.activeExecutor instanceof PiMessageExecutor)) return;
    const task = (await this.store.listTasks()).find((candidate) => candidate.status === "executing");
    const result = this.activeExecutor.fail(error);
    if (task && result) await this.store.saveExecution(task.id, result);
  }

  async createAndSendTask(workspaceRoot: string, request: string): Promise<{
    task: PlannerTask;
    browser: BrowserSendResult;
  }> {
    await this.start();
    const task = await this.store.createTask(workspaceRoot, request);
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
