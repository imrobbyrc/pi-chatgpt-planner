import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../src/config.js";
import { PlannerRuntime } from "../../src/service/runtime.js";
import { clearCredential, resolveCredential, storeCredential } from "../../src/service/auth.js";
import type { PlannerTask } from "../../src/types.js";
import { PiMessageExecutor } from "../../src/executor.js";
import { TaskResolver, taskShortId, taskTitle, type TaskCommand } from "../../src/task-resolver.js";
import { activeMethodNamesFromSession } from "../../src/skills.js";
import { parseAdjustment, parseFreeForm } from "../../src/command-parser.js";
import { HerdrCliAdapter, HerdrExecutor } from "../../src/herdr.js";

export function planningLabel(task: PlannerTask): "complete" | "failed" | "in progress" {
  if (task.status === "planning") return "in progress";
  if (task.status === "execution_failed" && !task.plan) return "failed";
  return "complete";
}

export function approvalLabel(task: PlannerTask): "awaiting approval" | "approved" | "rejected" | "not available" {
  if (task.status === "rejected") return "rejected";
  if (["approved", "executing", "execution_completed"].includes(task.status) || (task.status === "execution_failed" && Boolean(task.plan))) return "approved";
  if (["plan_received", "awaiting_approval"].includes(task.status)) return "awaiting approval";
  return "not available";
}

export function executionLabel(task: PlannerTask): "not started" | "executing" | "completed" | "failed" {
  if (task.status === "executing") return "executing";
  if (task.status === "execution_completed") return "completed";
  if (task.status === "execution_failed") return "failed";
  return "not started";
}

export function reviewLabel(task: PlannerTask): string {
  const review = task.review;
  if (!review) return "not started";
  const labels: Record<string, string> = {
    not_started: "not started", awaiting_review: "awaiting review", reviewing: "reviewing",
    approved: "approved", changes_requested: "changes requested", correction_executing: "correction executing",
    correction_completed: "correction complete", failed: "failed",
    max_iterations_reached: "max iterations reached", scope_expansion_required: "scope expansion required"
  };
  return `${labels[review.status] ?? review.status} (iterations: ${review.iteration})`;
}

function presentationState(task: PlannerTask): string {
  if (task.status === "awaiting_approval" || task.status === "plan_received") return "WAITING APPROVAL";
  if (task.status === "execution_completed" && task.review?.status === "approved") return "APPROVED";
  if (task.status === "execution_completed" && task.review?.status === "failed") return "NEEDS RECOVERY";
  return task.status.replaceAll("_", " ").toUpperCase();
}

export function renderStatus(task: PlannerTask): string {
  const base = `Planning: ${planningLabel(task)}\nApproval: ${approvalLabel(task)}\nExecution: ${executionLabel(task)}\nReview: ${reviewLabel(task)}`;
  const contract = task.plan?.execution;
  if (!contract) return base;
  const records = task.execution?.workers ?? [];
  const workers = contract.workers.map((worker) => {
    const record = records.find((item) => item.id === worker.id);
    const state = record?.state ?? (worker.dependsOn.length ? `waiting on ${worker.dependsOn.join(", ")}` : task.execution?.status === "running" ? "ready" : "pending");
    return `${state === "completed" ? "✓" : state === "failed" ? "✗" : "○"} ${worker.id} ${state}`;
  });
  return `${base}\nExecution mode: Herdr\nWorker model: Luna Max\nWorkers:\n${workers.join("\n")}`;
}

function renderReview(task: PlannerTask): string {
  const review = task.review;
  if (!review) return "## Review\nNot started.";
  const records = review.reviews.flatMap((record) => [
    `### Iteration ${record.iteration}: ${record.status}`,
    record.summary ?? record.error ?? "No summary.",
    ...record.findings.map((finding) => `- [${finding.severity}]${finding.file ? ` ${finding.file}${finding.line ? `:${finding.line}` : ""}:` : ""} ${finding.issue}${finding.requested_change ? ` → ${finding.requested_change}` : ""}`)
  ]);
  const reason = review.error?.kind === "planner_target_closed"
    ? "Reason: original Temporary Chat closed"
    : review.error ? `Reason: ${review.error.kind} — ${review.error.message}` : "";
  return ["## Review", reviewLabel(task), reason, ...records].filter(Boolean).join("\n");
}

function renderPlan(task: PlannerTask): string {
  const plan = task.plan;
  if (!plan) return "No plan available.";

  const revision = task.planRevisions?.currentRevision;
  const approved = task.planRevisions?.approvedRevision;
  const sections = [
    `# ${plan.summary}`,
    revision ? `Plan revision: ${revision}${approved === revision ? " (approved)" : ""}` : "",
    plan.context?.methods.length ? `Methods: ${plan.context.methods.join(", ")}` : "",
    plan.context?.skills.length ? `Skills: ${plan.context.skills.join(", ")}` : "",
    plan.execution ? `Execution: Herdr multi-agent · Luna Max · ${plan.execution.workers.length} workers\nWorkers: ${plan.execution.workers.map((worker) => worker.id).join(", ")}` : "",
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
  let currentTaskId: string | undefined;

  async function resolveTask(planner: PlannerRuntime, command: TaskCommand, explicitId?: string): Promise<PlannerTask> {
    const resolver = new TaskResolver(planner.store);
    if (currentTaskId) resolver.setCurrent(currentTaskId);
    const task = await resolver.resolve(command, explicitId);
    currentTaskId = task.id;
    return task;
  }

  function splitOptionalId(args: string): { id?: string; rest: string } {
    const parsed = parseAdjustment(args);
    return parsed.id ? { id: parsed.id, rest: parsed.feedback } : { rest: parsed.feedback };
  }

  function tunnelLabel(state: string, tunnel: { managedByPi: boolean; lastError: string | undefined }): string {
    if (state !== "ready") return tunnel.lastError && state === "failed" ? `failed (${tunnel.lastError})` : state;
    return tunnel.managedByPi ? "ready (started by Pi)" : "ready (external)";
  }

  function renderSnapshot(planner: PlannerRuntime, snapshot: { ready: boolean; mcp: string; tunnel: string; dia: string }): string {
    return [`Planner infrastructure: ${snapshot.ready ? "ready" : "not ready"}`, `MCP: ${snapshot.mcp}`, `Tunnel: ${tunnelLabel(snapshot.tunnel, planner.tunnel)}`, `Dia CDP: ${snapshot.dia}`].join("\n");
  }

  async function getRuntime(): Promise<PlannerRuntime> {
    if (!runtime) runtime = new PlannerRuntime(await loadConfig());
    await runtime.start();
    return runtime;
  }

  pi.registerCommand("chatgpt-planner-auth", {
    description: "Configure the Secure MCP Tunnel credential (one-time)",
    handler: async (_args, ctx) => {
      try {
        const config = runtime?.config ?? await loadConfig();
        if (await resolveCredential(config) && !await ctx.ui.confirm("Replace stored credential?", "A credential is already configured. Replace it?")) return;
        const credential = await ctx.ui.input("Secure MCP Tunnel runtime API key:", "paste CONTROL_PLANE_API_KEY value");
        if (credential === undefined) return;
        await storeCredential(config, credential);
        ctx.ui.notify(`Pi ChatGPT Planner authentication configured.\nCredential: configured\nStorage: ~/.pi/chatgpt-planner/.env\n\nRun:\n/chatgpt-planner-start`, "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    }
  });

  pi.registerCommand("chatgpt-planner-auth-clear", {
    description: "Remove the stored planner tunnel credential",
    handler: async (_args, ctx) => {
      try {
        const config = runtime?.config ?? await loadConfig();
        await clearCredential(config);
        ctx.ui.notify("Pi ChatGPT Planner authentication cleared.", "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    }
  });

  pi.registerCommand("chatgpt-planner-start", {
    description: "Start planner infrastructure",
    handler: async (_args, ctx) => {
      try {
        const planner = await getRuntime();
        ctx.ui.setStatus("chatgpt-planner-start", "Starting Pi ChatGPT Planner…");
        if (!(await planner.tunnel.credentialConfigured())) {
          ctx.ui.setStatus("chatgpt-planner-start", undefined);
          ctx.ui.notify("Authentication missing.\n\nRun:\n/chatgpt-planner-auth", "error");
          return;
        }
        const snapshot = await planner.startInfrastructure((message) => ctx.ui.setStatus("chatgpt-planner-start", `Starting Pi ChatGPT Planner… ${message}`));
        ctx.ui.setStatus("chatgpt-planner-start", undefined);
        const failureDetail = snapshot.ready || !planner.tunnel.lastError ? "" : `\n${planner.tunnel.lastError}`;
        ctx.ui.notify(`Pi ChatGPT Planner ${snapshot.ready ? "ready" : "not ready"}\n${renderSnapshot(planner, snapshot)}${failureDetail}`, snapshot.ready ? "info" : "warning"); // exactly one final result
      } catch (error) {
        ctx.ui.setStatus("chatgpt-planner-start", undefined);
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    }
  });

  pi.registerCommand("chatgpt-planner-stop", {
    description: "Stop planner infrastructure owned by this Pi runtime",
    handler: async (_args, ctx) => {
      try {
        if (!runtime) { ctx.ui.notify("Pi ChatGPT Planner stopped", "info"); return; }
        const pending = await runtime.pendingReviewTasks();
        if (pending.length) ctx.ui.notify("Planner has unfinished review tasks. Closing planner browser will make their Temporary Chat review context unavailable.", "warning");
        const status = await runtime.stop();
        ctx.ui.notify(["Pi ChatGPT Planner stopped", `Tunnel: ${status.tunnel}`, `Dia CDP: ${status.dia}`, `MCP: ${status.mcp}`, `Planner: ${status.ready ? "running" : "stopped"}`].join("\n"), "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    }
  });

  pi.registerCommand("chatgpt-plan-review", {
    description: "Retry review for an executed task in its original ChatGPT conversation",
    handler: async (args, ctx) => {
      try {
        const planner = await getRuntime();
        const { id } = splitOptionalId(args);
        const task = await resolveTask(planner, "review", id);
        const outcome = await planner.reviews.startReview(task.id);
        const finalTask = await planner.store.getTask(task.id);
        ctx.ui.notify(`Review ${outcome}\n${finalTask.review?.status ?? "no review"}`, "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    }
  });

  pi.registerCommand("chatgpt-plan-recover", {
    description: "Recover legacy operational review attempts without changing source or semantic review count",
    handler: async (args, ctx) => {
      try {
        const planner = await getRuntime();
        const { id } = splitOptionalId(args);
        const selected = await resolveTask(planner, "recover", id);
        const outcome = await planner.reviews.startReview(selected.id);
        const task = await planner.store.getTask(selected.id);
        ctx.ui.notify(`Review recovery: ${outcome}\n${taskShortId(task)} ${task.review?.status ?? "unknown"}`, "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    }
  });

  pi.registerCommand("chatgpt-plan-adjust", {
    description: "Request a complete plan revision before approval",
    handler: async (args, ctx) => {
      try {
        const planner = await getRuntime();
        const { id, rest } = splitOptionalId(args);
        if (!rest) { ctx.ui.notify("Usage: /chatgpt-plan-adjust [task-id] <feedback>", "warning"); return; }
        const task = await resolveTask(planner, "adjust", id);
        const updated = await planner.adjustPlan(task.id, rest);
        currentTaskId = updated.id;
        ctx.ui.notify(`ChatGPT revised the plan.\nTask: ${taskShortId(updated)}\nPlan revision: ${updated.planRevisions?.currentRevision ?? 1}\nApproval: awaiting approval\n\nNext: /chatgpt-plan-approve`, "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    }
  });

  pi.registerCommand("chatgpt-plan-list", {
    description: "List recent planner tasks",
    handler: async (_args, ctx) => {
      try {
        const planner = await getRuntime();
        const tasks = await planner.store.listTasks();
        const lines = tasks.slice(0, 15).map((task) => `${taskShortId(task)}  ${presentationState(task).padEnd(20)} ${taskTitle(task)}`);
        const picked = ctx.hasUI && lines.length > 1 ? await ctx.ui.select("Select planner task", lines) : undefined;
        if (picked) { const selected = tasks[lines.indexOf(picked)]!; currentTaskId = selected.id; ctx.ui.notify(`Current planner task: ${taskShortId(selected)}`, "info"); }
        else if (ctx.hasUI) await ctx.ui.editor("Recent planner tasks", ["Recent planner tasks", "", ...lines].join("\n"));
        else ctx.ui.notify(["Recent planner tasks", ...lines].join("\n"), "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    }
  });

  async function runPlanning(args: string, ctx: Parameters<NonNullable<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>>[1], mode: "single" | "herdr") {
    const request = parseFreeForm(args);
    if (!request) { ctx.ui.notify("Usage: /chatgpt-plan <task>", "warning"); return; }
    if (!ctx.isProjectTrusted()) { ctx.ui.notify("This project must be trusted before exposing workspace reads through MCP.", "error"); return; }
    const planner = await getRuntime();
    const snapshot = await planner.infraSnapshot();
    if (!snapshot.ready) { ctx.ui.notify(`Pi ChatGPT Planner is not ready.\n${renderSnapshot(planner, snapshot)}\nRun /chatgpt-planner-start and retry.`, "error"); return; }
    ctx.ui.setStatus("chatgpt-planner", "Preparing ChatGPT planner…");
    try {
      const activeMethods = activeMethodNamesFromSession(ctx.sessionManager.getBranch());
      const { task, browser } = await planner.createAndSendTask(ctx.cwd, request, activeMethods, mode);
      currentTaskId = task.id;
      ctx.ui.setStatus("chatgpt-planner", `Waiting for ChatGPT plan (${task.id.slice(0, 8)})…`);
      for (const warning of browser.warnings) ctx.ui.notify(warning, "warning");
      const completed = await planner.store.waitForPlan(task.id, planner.config.planTimeoutMs);
      ctx.ui.setStatus("chatgpt-planner", undefined);
      ctx.ui.setWidget("chatgpt-planner", [`✓ ChatGPT plan received: ${completed.plan?.summary ?? task.id}`, `Task ${task.id.slice(0, 8)} · use /chatgpt-plan-status to reopen`]);
      ctx.ui.notify(mode === "herdr" ? "ChatGPT multi-agent plan received." : "ChatGPT planning round-trip completed.", "info");
      if (ctx.hasUI) await ctx.ui.editor(mode === "herdr" ? "ChatGPT multi-agent plan — awaiting approval" : "ChatGPT plan — awaiting approval", renderPlan(completed));
    } catch (error) { ctx.ui.setStatus("chatgpt-planner", undefined); ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
  }

  pi.registerCommand("chatgpt-plan-max", { description: "Ask ChatGPT Web for an explicit Herdr multi-agent plan", handler: async (args, ctx) => runPlanning(args, ctx, "herdr") });

  pi.registerCommand("chatgpt-plan", {
    description: "Ask ChatGPT Web to inspect this workspace via MCP and return a plan",
    handler: async (args, ctx) => {
      const request = parseFreeForm(args);
      if (!request) {
        ctx.ui.notify("Usage: /chatgpt-plan <task>", "warning");
        return;
      }

      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("This project must be trusted before exposing workspace reads through MCP.", "error");
        return;
      }

      const planner = await getRuntime();
      const snapshot = await planner.infraSnapshot();
      if (!snapshot.ready) {
        ctx.ui.notify(`Pi ChatGPT Planner is not ready.\n${renderSnapshot(planner, snapshot)}\nRun /chatgpt-planner-start and retry.`, "error");
        return;
      }
      ctx.ui.setStatus("chatgpt-planner", "Preparing ChatGPT planner…");

      try {
        const activeMethods = activeMethodNamesFromSession(ctx.sessionManager.getBranch());
        const { task, browser } = await planner.createAndSendTask(ctx.cwd, request, activeMethods);
        currentTaskId = task.id;
        ctx.ui.setStatus("chatgpt-planner", `Waiting for ChatGPT plan (${task.id.slice(0, 8)})…`);
        for (const warning of browser.warnings) {
          ctx.ui.notify(warning, "warning");
        }

        const completed = await planner.store.waitForPlan(task.id, planner.config.planTimeoutMs);
        const markdown = renderPlan(completed);
        ctx.ui.setStatus("chatgpt-planner", undefined);
        ctx.ui.setWidget("chatgpt-planner", [
          `✓ ChatGPT plan received: ${completed.plan?.summary ?? task.id}`,
          `Task ${task.id.slice(0, 8)} · use /chatgpt-plan-status to reopen`
        ]);
        ctx.ui.notify("ChatGPT planning round-trip completed.", "info");
        if (ctx.hasUI) {
          await ctx.ui.editor("ChatGPT plan — awaiting approval", markdown);
        }
      } catch (error) {
        ctx.ui.setStatus("chatgpt-planner", undefined);
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    }
  });

  pi.registerCommand("chatgpt-plan-approve", {
    description: "Approve a received ChatGPT plan and execute it in Pi",
    handler: async (args, ctx) => {
      try {
        const planner = await getRuntime();
        const { id } = splitOptionalId(args);
        const selected = await resolveTask(planner, "approve", id);
        const executor = selected.requestedExecutionMode === "herdr"
          ? new HerdrExecutor(new HerdrCliAdapter(), new PiMessageExecutor((message) => pi.sendUserMessage(message)))
          : new PiMessageExecutor((message) => pi.sendUserMessage(message));
        const task = await planner.approveTask(selected.id, executor);
        ctx.ui.notify(`${task.id}: ${task.status}`, "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    }
  });

  pi.registerCommand("chatgpt-plan-reject", {
    description: "Reject a received ChatGPT plan",
    handler: async (args, ctx) => {
      try {
        const planner = await getRuntime();
        const { id } = splitOptionalId(args);
        const selected = await resolveTask(planner, "reject", id);
        const task = await planner.rejectTask(selected.id);
        ctx.ui.notify(`${task.id}: ${task.status}`, "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
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
        const { id } = splitOptionalId(args);
        const task = await resolveTask(planner, "status", id);
        if (!task) {
          ctx.ui.notify("No planner tasks found.", "warning");
          return;
        }
        const details = task.plan
          ? [renderStatus(task), "", renderPlan(task), task.execution ? `## Execution\n${task.execution.summary}\n\nValidations:\n${task.execution.validations.map((v) => `- ${v}`).join("\n") || "- None"}${task.execution.error ? `\n\nError: ${task.execution.error}` : ""}` : "", "", renderReview(task)].join("\n")
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
        const config = runtime?.config ?? await loadConfig();
        const snapshot = runtime ? await runtime.infraSnapshot() : { ready: false, mcp: "stopped", tunnel: "stopped", dia: "stopped" };
        const auth = await resolveCredential(config) ? "configured" : "missing";
        const lines = [
          `Planner infrastructure: ${snapshot.ready ? "ready" : "not ready"}`,
          `Authentication: ${auth}`,
          `MCP: ${snapshot.mcp}`,
          `Tunnel: ${runtime ? tunnelLabel(snapshot.tunnel, runtime.tunnel) : snapshot.tunnel}`,
          `Dia CDP: ${snapshot.dia}`,
          `Local MCP: http://${config.mcpHost}:${config.mcpPort}${config.mcpPath}`,
          `Public MCP: ${config.publicMcpUrl ?? "not configured"}`,
          `State dir: ${config.stateDir}`,
          `Browser: ${config.browser}`,
          `Browser/CDP: http://${config.cdpHost}:${config.cdpPort}`,
          `Browser profile: ${config.browserProfileDir}`,
          `ChatGPT app: ${config.chatgptAppName}`,
          `Auto-attach app: ${config.browserAutoAttachApp}`
        ];
        if (ctx.hasUI) await ctx.ui.editor("pi-chatgpt-planner info", lines.join("\n"));
        else ctx.ui.notify(lines.join(" | "), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (runtime?.executionPromptMatches(event.prompt)) ctxSafeStatus();
  });
  pi.on("agent_end", async (event) => { await runtime?.handleAgentEnd(event.messages); });
  pi.on("agent_settled", async () => { /* completion handled by agent_end */ });

  function ctxSafeStatus(): void { /* correlation hook intentionally has no UI side effects */ }

  pi.on("session_shutdown", async () => {
    // No transcript UI is available here; runtime persists planner_target_closed before cleanup.
    await runtime?.stop();
    runtime = undefined;
  });
}
