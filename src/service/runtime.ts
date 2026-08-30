import type { PlannerConfig, PlannerTask } from "../types.js";
import { TaskStore } from "../task-store.js";
import { PlannerMcpHttpServer } from "../mcp/server.js";
import { ChatGptBrowserController, type BrowserSendResult } from "../browser/chatgpt.js";

export class PlannerRuntime {
  readonly store: TaskStore;
  readonly mcp: PlannerMcpHttpServer;
  readonly browser: ChatGptBrowserController;

  constructor(readonly config: PlannerConfig) {
    this.store = new TaskStore(config.stateDir);
    this.mcp = new PlannerMcpHttpServer(this.store, config);
    this.browser = new ChatGptBrowserController(config);
  }

  async start(): Promise<void> {
    await this.mcp.start();
  }

  async stop(): Promise<void> {
    await this.mcp.stop();
  }

  async debugBrowser(): Promise<{ path: string; report: unknown }> {
    await this.start();
    return this.browser.debugPlannerTab();
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
