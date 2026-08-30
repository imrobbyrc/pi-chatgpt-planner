import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../src/config.js";
import { PlannerRuntime } from "../../src/service/runtime.js";
import type { PlannerTask } from "../../src/types.js";

function renderPlan(task: PlannerTask): string {
  const plan = task.plan;
  if (!plan) return "No plan available.";

  const sections = [
    `# ${plan.summary}`,
    "",
    plan.planMarkdown.trim(),
    "",
    "## Acceptance criteria",
    ...(plan.acceptanceCriteria.length ? plan.acceptanceCriteria.map((item) => `- ${item}`) : ["- None supplied"]),
    "",
    "## Tests",
    ...(plan.tests.length ? plan.tests.map((item) => `- ${item}`) : ["- None supplied"]),
    "",
    "## Risks",
    ...(plan.risks.length ? plan.risks.map((item) => `- ${item}`) : ["- None supplied"]),
    "",
    "## Open questions",
    ...(plan.openQuestions.length ? plan.openQuestions.map((item) => `- ${item}`) : ["- None"])
  ];
  return sections.join("\n");
}

export default function chatGptPlannerExtension(pi: ExtensionAPI) {
  let runtime: PlannerRuntime | undefined;

  async function getRuntime(): Promise<PlannerRuntime> {
    if (!runtime) runtime = new PlannerRuntime(await loadConfig());
    await runtime.start();
    return runtime;
  }

  pi.registerCommand("chatgpt-plan", {
    description: "Ask ChatGPT Web to inspect this workspace via MCP and return a plan",
    handler: async (args, ctx) => {
      const request = args.trim();
      if (!request) {
        ctx.ui.notify("Usage: /chatgpt-plan <task>", "warning");
        return;
      }

      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("This project must be trusted before exposing workspace reads through MCP.", "error");
        return;
      }

      const planner = await getRuntime();
      ctx.ui.setStatus("chatgpt-planner", "Preparing ChatGPT planner…");

      try {
        const { task, browser } = await planner.createAndSendTask(ctx.cwd, request);
        ctx.ui.setStatus("chatgpt-planner", `Waiting for ChatGPT plan (${task.id.slice(0, 8)})…`);
        for (const warning of browser.warnings) {
          ctx.ui.notify(warning, "warning");
        }

        const completed = await planner.store.waitForPlan(task.id, planner.config.planTimeoutMs);
        const markdown = renderPlan(completed);
        ctx.ui.setStatus("chatgpt-planner", undefined);
        ctx.ui.setWidget("chatgpt-planner", [
          `✓ ChatGPT plan received: ${completed.plan?.summary ?? task.id}`,
          `Task ${task.id.slice(0, 8)} · use /chatgpt-plan-status ${task.id} to reopen`
        ]);
        ctx.ui.notify("ChatGPT planning round-trip completed.", "info");
        if (ctx.hasUI) {
          await ctx.ui.editor("ChatGPT plan (V0 preview only — no execution yet)", markdown);
        }
      } catch (error) {
        ctx.ui.setStatus("chatgpt-planner", undefined);
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    }
  });

  pi.registerCommand("chatgpt-browser-debug", {
    description: "Capture visible ChatGPT planner-tab controls and state via CDP",
    handler: async (_args, ctx) => {
      try {
        const planner = await getRuntime();
        const { path, report } = await planner.debugBrowser();
        ctx.ui.notify(`ChatGPT browser diagnostics saved: ${path}`, "info");
        if (ctx.hasUI) await ctx.ui.editor("ChatGPT browser diagnostics", JSON.stringify(report, null, 2));
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    }
  });

  pi.registerCommand("chatgpt-plan-status", {
    description: "Show a ChatGPT planner task by id, or the newest task when id is omitted",
    handler: async (args, ctx) => {
      try {
        const planner = await getRuntime();
        const id = args.trim();
        const task = id
          ? await planner.store.getTask(id)
          : (await planner.store.listTasks())[0];
        if (!task) {
          ctx.ui.notify("No planner tasks found.", "warning");
          return;
        }
        const details = task.plan
          ? renderPlan(task)
          : `Task: ${task.id}\nStatus: ${task.status}\nRequest: ${task.request}\n${task.error ? `Error: ${task.error}` : ""}`;
        if (ctx.hasUI) await ctx.ui.editor(`Planner task ${task.id.slice(0, 8)}`, details);
        else ctx.ui.notify(`${task.id}: ${task.status}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    }
  });

  pi.registerCommand("chatgpt-planner-info", {
    description: "Show local MCP and browser-control configuration",
    handler: async (_args, ctx) => {
      try {
        const planner = await getRuntime();
        const lines = [
          `Local MCP: ${planner.mcp.localUrl}`,
          `Public MCP: ${planner.config.publicMcpUrl ?? "not configured"}`,
          `State dir: ${planner.config.stateDir}`,
          `Browser: ${planner.config.browser}`,
          `Browser/CDP: http://${planner.config.cdpHost}:${planner.config.cdpPort}`,
          `Browser profile: ${planner.config.browserProfileDir}`,
          `ChatGPT app: ${planner.config.chatgptAppName}`,
          `Auto-attach app: ${planner.config.browserAutoAttachApp}`
        ];
        if (ctx.hasUI) await ctx.ui.editor("pi-chatgpt-planner info", lines.join("\n"));
        else ctx.ui.notify(lines.join(" | "), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    }
  });

  pi.on("session_shutdown", async () => {
    await runtime?.stop();
    runtime = undefined;
  });
}
