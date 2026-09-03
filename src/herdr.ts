import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { ExecutionResult, HerdrAgentState, HerdrDiagnostic, HerdrTurnEvidence, HerdrWorker, HerdrWorkerRecord, WorkspaceBaseline } from "./types.js";
import type { PlannerExecutor, PlannerExecutorInput } from "./executor.js";
import { validateHerdrContract, readyWorkers, scopesOverlap, type WorkerState } from "./herdr-contract.js";
import { changedFilesFromBaseline, gitDiff, gitStatus, captureWorkspaceBaseline } from "./workspace/git.js";

const exec = promisify(execFile);
export const LUNA_MAX_PROFILE = { displayName: "Luna Max", provider: "openai-codex", model: "gpt-5.6-luna", modelId: "openai-codex/gpt-5.6-luna", thinkingLevel: "max" } as const;
export const LUNA_MAX_MODEL = LUNA_MAX_PROFILE.modelId;
export const LUNA_MAX_LABEL = LUNA_MAX_PROFILE.displayName;
export const HERDR_AGENT_NAME_MAX_LENGTH = 32;
const HERDR_AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export class HerdrStartupError extends Error {
  constructor(message: string, readonly paneId: string, readonly diagnostic?: HerdrDiagnostic) { super(message); this.name = "HerdrStartupError"; }
}

function diagnostic(operation: HerdrDiagnostic["operation"], args: string[], error: unknown, paneId?: string, agentHandle?: string, protocolError?: string): HerdrDiagnostic {
  const value = error as { code?: number | string; status?: number; stdout?: string; stderr?: string };
  return { operation, args, ...(typeof value.status === "number" ? { exitCode: value.status } : typeof value.code === "number" ? { exitCode: value.code } : {}), stdout: value.stdout ?? "", stderr: value.stderr ?? String(error), ...(paneId ? { paneId } : {}), ...(agentHandle ? { agentHandle } : {}), ...(protocolError ? { protocolError } : {}) };
}
function successDiagnostic(operation: HerdrDiagnostic["operation"], args: string[], stdout: string, stderr: string, paneId?: string, agentHandle?: string): HerdrDiagnostic {
  return { operation, args, exitCode: 0, stdout, stderr, ...(paneId ? { paneId } : {}), ...(agentHandle ? { agentHandle } : {}) };
}

export function herdrAgentHandle(taskId: string, workerId: string): string {
  const slug = workerId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 8).replace(/[-_]+$/g, "") || "worker";
  const hash = createHash("sha256").update(`${taskId}\0${workerId}`).digest("hex").slice(0, 8);
  return `pp-${taskId.slice(0, 8).toLowerCase()}-${slug}-${hash}`;
}

export function validateHerdrAgentHandles(handles: readonly string[]): void {
  if (handles.some((handle) => !HERDR_AGENT_NAME_PATTERN.test(handle))) throw new Error("Invalid Herdr runtime handle generated.");
  if (new Set(handles).size !== handles.length) throw new Error("Herdr runtime handle collision; execution refused before pane creation.");
}

export function herdrAgentStartArgs(paneId: string, handle = "worker"): string[] {
  return ["agent", "start", handle, "--kind", "pi", "--pane", paneId, "--", "--model", LUNA_MAX_MODEL, "--thinking", LUNA_MAX_PROFILE.thinkingLevel, "--no-session"];
}

export function isSourceMutationPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return !normalized.startsWith("docs/") && !normalized.startsWith(".pi/") && !normalized.startsWith(".git/")
    && !/^(README|ROADMAP|CHANGELOG|THIRD_PARTY_NOTICES)(\.|$)/i.test(normalized)
    && !/\.(md|markdown|txt|json|lock)$/i.test(normalized);
}

export interface HerdrAdapter {
  isAvailable(): Promise<boolean>;
  spawn(worker: HerdrWorker, workspaceRoot: string, prompt: string, agentHandle: string, onPane?: (paneId: string, evidence: HerdrDiagnostic) => Promise<void>, onIdentity?: (identity: { paneId: string; agentHandle: string }, evidence: HerdrDiagnostic) => Promise<void>): Promise<{ paneId: string; agentHandle: string }>;
  wait(agentHandle: string): Promise<{ status: "completed" | "failed"; output: string; error?: string; diagnostic?: HerdrDiagnostic }>;
  reuse(agentHandle: string, prompt: string, paneId?: string): Promise<{ status: "completed" | "failed"; output: string; error?: string; turn?: HerdrTurnEvidence }>;
  stop(agentHandle: string): Promise<void>;
}

export class HerdrCliAdapter implements HerdrAdapter {
  private readonly panes = new Map<string, string>();
  constructor(private readonly command = "herdr", private readonly piCommand = "pi") {}
  async isAvailable(): Promise<boolean> {
    try {
      await exec(this.command, ["status", "server"], { timeout: 5_000 });
      await exec(this.piCommand, ["auth", "check", "--provider", "openai-codex"], { timeout: 10_000 });
      return true;
    } catch { return false; }
  }
  async spawn(worker: HerdrWorker, workspaceRoot: string, prompt: string, agentHandle: string, onPane?: (paneId: string, evidence: HerdrDiagnostic) => Promise<void>, onIdentity?: (identity: { paneId: string; agentHandle: string }, evidence: HerdrDiagnostic) => Promise<void>): Promise<{ paneId: string; agentHandle: string }> {
    const splitArgs = ["pane", "split", "--current", "--direction", "right", "--cwd", workspaceRoot, "--no-focus"];
    let split;
    try { split = await exec(this.command, splitArgs, { timeout: 10_000 }); } catch (error) { throw new HerdrStartupError(error instanceof Error ? error.message : String(error), "", diagnostic("pane split", splitArgs, error)); }
    const paneId = parsePaneSplit(split.stdout) ?? (() => { throw new Error("Herdr pane split returned no authoritative result.pane.pane_id"); })();
    try {
      await onPane?.(paneId, successDiagnostic("pane split", splitArgs, split.stdout, split.stderr, paneId));
      const handle = agentHandle;
      const startArgs = herdrAgentStartArgs(paneId, handle);
      const started = await exec(this.command, startArgs, { timeout: 15_000 });
      let identity: { agentHandle: string; paneId: string };
      try { identity = parseAgentStart(started.stdout, handle, paneId); } catch (error) {
        const protocolError = error instanceof Error ? error.message : String(error);
        throw new HerdrStartupError(protocolError, paneId, { operation: "agent start", args: startArgs.map((arg) => arg === handle ? "<agent-handle>" : arg), exitCode: 0, stdout: started.stdout, stderr: started.stderr, paneId, protocolError });
      }
      this.panes.set(identity.agentHandle, paneId);
      await onIdentity?.(identity, successDiagnostic("agent start", startArgs, started.stdout, started.stderr, paneId, identity.agentHandle));
      try { await exec(this.command, ["agent", "prompt", identity.agentHandle, prompt, "--wait"], { timeout: 86_400_000 }); } catch (error) { throw new HerdrStartupError(error instanceof Error ? error.message : String(error), paneId, diagnostic("agent prompt", ["agent", "prompt", identity.agentHandle, "<worker-prompt>", "--wait"], error, paneId, identity.agentHandle)); }
      return identity;
    } catch (error) {
      try { await exec(this.command, ["pane", "close", paneId]); } catch { /* preserve primary error */ }
      this.panes.delete(agentHandle);
      throw error instanceof HerdrStartupError ? error : new HerdrStartupError(error instanceof Error ? error.message : String(error), paneId, diagnostic("agent start", ["agent", "start", worker.id, "--kind", "pi", "--pane", paneId, "<pi-args>"], error, paneId));
    }
  }
  async wait(agentHandle: string) {
    const args = ["agent", "wait", agentHandle];
    try {
      const result = await exec(this.command, args, { timeout: 86_400_000 });
      return { status: "completed" as const, output: result.stdout };
    } catch (error) { return { status: "failed" as const, output: "", error: error instanceof Error ? error.message : String(error), diagnostic: diagnostic("agent wait", args, error, undefined, agentHandle) }; }
  }
  async reuse(agentHandle: string, prompt: string, paneId?: string) {
    const getArgs = ["agent", "get", agentHandle];
    const promptArgs = ["agent", "prompt", agentHandle, "<correction-prompt>", "--wait"];
    let before: HerdrAgentState | undefined;
    let beforeDiagnostic: HerdrDiagnostic | undefined;
    let afterDiagnostic: HerdrDiagnostic | undefined;
    let promptDiagnostic: HerdrDiagnostic | undefined;
    try {
      const get = await exec(this.command, getArgs, { timeout: 10_000 });
      before = parseAgentState(get.stdout, agentHandle, paneId);
      beforeDiagnostic = successDiagnostic("agent get", getArgs, get.stdout, get.stderr, before.paneId, agentHandle);
      let result;
      try {
        result = await exec(this.command, ["agent", "prompt", agentHandle, prompt, "--wait"], { timeout: 86_400_000 });
        promptDiagnostic = successDiagnostic("agent prompt", promptArgs, result.stdout, result.stderr, before.paneId, agentHandle);
      } catch (error) {
        promptDiagnostic = diagnostic("agent prompt", promptArgs, error, before.paneId, agentHandle);
        return { status: "failed" as const, output: "", error: error instanceof Error ? error.message : String(error), turn: { agentHandle, paneId: before.paneId, before, prompt: promptDiagnostic, turnObserved: false, ...(beforeDiagnostic || afterDiagnostic ? { diagnostics: [beforeDiagnostic, afterDiagnostic].filter((item): item is HerdrDiagnostic => Boolean(item)) } : {}) } };
      }
      const afterGet = await exec(this.command, getArgs, { timeout: 10_000 });
      afterDiagnostic = successDiagnostic("agent get", getArgs, afterGet.stdout, afterGet.stderr, paneId, agentHandle);
      const after = parseAgentState(afterGet.stdout, agentHandle, paneId);
      const turnObserved = typeof before.stateChangeSeq === "number" && typeof after.stateChangeSeq === "number" && after.stateChangeSeq > before.stateChangeSeq;
      const turn: HerdrTurnEvidence = { agentHandle, paneId: after.paneId, before, prompt: promptDiagnostic, after, turnObserved, diagnostics: [beforeDiagnostic, afterDiagnostic] };
      if (!turnObserved) return { status: "failed" as const, output: result.stdout, error: "Herdr correction turn was not observed: state_change_seq did not advance.", turn };
      return { status: "completed" as const, output: result.stdout, turn };
    } catch (error) {
      return { status: "failed" as const, output: "", error: error instanceof Error ? error.message : String(error), ...(before && promptDiagnostic ? { turn: { agentHandle, paneId: paneId ?? before.paneId, before, prompt: promptDiagnostic, turnObserved: false } } : {}) };
    }
  }
  async stop(agentHandle: string): Promise<void> {
    const paneId = this.panes.get(agentHandle);
    try { if (paneId) await exec(this.command, ["pane", "close", paneId]); } catch { /* already gone */ }
    this.panes.delete(agentHandle);
  }
}
export function parseAgentState(output: string, expectedHandle: string, expectedPaneId?: string): HerdrAgentState {
  let agent: { name?: string; pane_id?: string; agent_status?: string; state_change_seq?: number; revision?: number; interactive_ready?: boolean } | undefined;
  try { agent = (JSON.parse(output) as { result?: { agent?: typeof agent } }).result?.agent; } catch { /* protocol error below */ }
  if (!agent?.name || !agent.pane_id) throw new Error("Herdr agent get returned incomplete agent identity (name/pane_id required)");
  if (agent.name !== expectedHandle) throw new Error(`Herdr agent get returned mismatched handle: expected ${expectedHandle}, got ${agent.name}`);
  if (expectedPaneId && agent.pane_id !== expectedPaneId) throw new Error(`Herdr agent get returned mismatched pane: expected ${expectedPaneId}, got ${agent.pane_id}`);
  if (agent.interactive_ready === false) throw new Error("Herdr agent get returned non-interactive agent context");
  return { name: agent.name, paneId: agent.pane_id, ...(agent.agent_status ? { agentStatus: agent.agent_status } : {}), ...(typeof agent.state_change_seq === "number" ? { stateChangeSeq: agent.state_change_seq } : {}), ...(typeof agent.revision === "number" ? { revision: agent.revision } : {}), ...(typeof agent.interactive_ready === "boolean" ? { interactiveReady: agent.interactive_ready } : {}) };
}

export function parseAgentStart(output: string, expectedHandle: string, expectedPaneId: string): { agentHandle: string; paneId: string } {
  const parsed = (() => { try { return (JSON.parse(output) as { result?: { agent?: { name?: string; pane_id?: string } } }).result?.agent; } catch { return undefined; } })();
  if (!parsed?.name || !parsed.pane_id) throw new Error("Herdr agent start returned incomplete agent identity (name/pane_id required)");
  if (parsed.name !== expectedHandle) throw new Error(`Herdr agent start returned mismatched handle: expected ${expectedHandle}, got ${parsed.name}`);
  if (parsed.pane_id !== expectedPaneId) throw new Error(`Herdr agent start returned mismatched pane: expected ${expectedPaneId}, got ${parsed.pane_id}`);
  return { agentHandle: parsed.name, paneId: parsed.pane_id };
}

export function extractHerdrIdentity(output: string, key: "pane_id" | "agent_id"): string | undefined {
  try {
    const visit = (value: unknown): string | undefined => {
      if (!value || typeof value !== "object") return undefined;
      if (key in value && typeof (value as Record<string, unknown>)[key] === "string") return (value as Record<string, string>)[key];
      for (const child of Object.values(value)) { const found = visit(child); if (found) return found; }
      return undefined;
    };
    return visit(JSON.parse(output));
  } catch {
    const match = output.match(new RegExp(`${key}[^A-Za-z0-9]+([A-Za-z0-9:._-]+)`));
    return match?.[1] ?? match?.[0];
  }
}
export function parsePaneSplit(output: string): string | undefined {
  try { return (JSON.parse(output) as { result?: { pane?: { pane_id?: string } } }).result?.pane?.pane_id; } catch { return undefined; }
}

export function workerPrompt(input: PlannerExecutorInput, worker: HerdrWorker, completed: string[]): string {
  const context = input.plan.context ? `\nApproved methods: ${input.plan.context.methods.join(", ") || "none"}\nApproved skills: ${input.plan.context.skills.join(", ") || "none"}` : "";
  const correction = (input.round ?? 0) > 0 ? [
    "",
    "CORRECTION TURN",
    "The previous objective above is historical context only for this correction turn.",
    "CURRENT CORRECTION INSTRUCTIONS are authoritative and SUPERSEDE conflicting content or state requirements from the original objective.",
    "Do not restore or preserve an old target state when the correction explicitly asks you to change it.",
    "Ownership, allowed file scope, dependencies, execution boundaries, and global safety constraints remain binding.",
    "Inspect the current workspace and apply ONLY the requested correction.",
    "Do not replay the original task or revert the requested correction merely to satisfy the original content target.",
    "Original objective (historical context):",
    worker.objective,
    "Current correction instructions:",
    input.instructions
  ].join("\n") : "";
  return [`You are worker "${worker.id}" in approved Herdr multi-agent execution.`, `Task ID: ${input.taskId}`, `Approved revision: ${input.approvedRevision ?? "locked"}`, `Objective: ${worker.objective}`, `Ownership: ${worker.owns.join(", ")}`, `Completed dependencies: ${completed.join(", ") || "none"}`, context, "Work only within assigned scope. Do not spawn agents, delegate, start Herdr panes, commit, push, deploy, or expand scope. Report blockers, files changed, and validations to Pi Lead.", correction].join("\n");
}

export class HerdrExecutor implements PlannerExecutor {
  constructor(private readonly adapter: HerdrAdapter, private readonly lead?: PlannerExecutor) {}
  async execute(input: PlannerExecutorInput): Promise<ExecutionResult> {
    const contract = input.plan.execution;
    if ((input.round ?? 0) > 0) {
      if (input.correctionWorkerId && (input.correctionAgentHandle ?? input.correctionAgentId)) {
        const startedAt = new Date().toISOString();
        const roundBaseline = await captureWorkspaceBaseline(input.workspaceRoot);
        const baseline = input.executionBaseline ?? roundBaseline;
        const result = await this.adapter.reuse(input.correctionAgentHandle ?? input.correctionAgentId!, workerPrompt({ ...input, instructions: input.instructions }, { id: input.correctionWorkerId, objective: input.correctionObjective ?? "Correct approved worker slice", owns: input.correctionOwnership ?? [], dependsOn: [] }, []), input.correctionPaneId);
        const filesChanged = await changedFilesFromBaseline(input.workspaceRoot, baseline);
        const correctionFilesChanged = await changedFilesFromBaseline(input.workspaceRoot, roundBaseline);
        const ownersByFile = Object.fromEntries(filesChanged.map((file) => [file, (contract?.workers ?? []).filter((worker) => worker.owns.some((scope) => scope === file || (scope.endsWith("/**") && file.startsWith(scope.slice(0, -3))))).map((worker) => worker.id)]));
        const unownedFiles = filesChanged.filter((file) => ownersByFile[file]!.length === 0);
        const ambiguousOwnerFiles = filesChanged.filter((file) => ownersByFile[file]!.length > 1);
        const scopeEvidence = { changedFiles: filesChanged, unownedFiles, ambiguousOwnerFiles, ownersByFile };
        const unsafe = unownedFiles.some(isSourceMutationPath) || ambiguousOwnerFiles.length > 0;
        const turnProven = result.status === "completed" && result.turn?.turnObserved === true;
        const attempt = input.correctionAttemptId ? { attemptId: input.correctionAttemptId, round: input.round ?? 0, route: "herdr-worker" as const, status: result.status === "completed" && result.turn?.turnObserved ? "completed" as const : "failed" as const, workerId: input.correctionWorkerId ?? "", agentHandle: input.correctionAgentHandle ?? input.correctionAgentId ?? "", paneId: input.correctionPaneId ?? "", correctionRoundBaseline: roundBaseline, ...(result.turn ? { herdrTurn: result.turn } : {}), correctionFilesChanged, filesChanged, scopeEvidence, ...(result.status === "completed" && result.turn?.turnObserved && !unsafe ? { proof: { route: "herdr-worker" as const, attemptId: input.correctionAttemptId, round: input.round ?? 0, matched: true } } : {}) } : undefined;
        const common = { startedAt, completedAt: new Date().toISOString(), filesChanged, correctionRoundBaseline: roundBaseline, scopeEvidence, ...(attempt ? { correctionAttemptId: input.correctionAttemptId, correctionAttempt: attempt } : {}), ...(result.turn ? { herdrTurn: result.turn } : {}), ...(input.round !== undefined ? { round: input.round } : {}) };
        if (!turnProven || unsafe) return { status: "failed", summary: result.error ?? (unsafe ? "Correction changed files outside approved ownership." : "Herdr correction turn was not proven."), validations: [], deviations: correctionFilesChanged.map((file) => `correction changed: ${file}`), remainingIssues: unsafe ? unownedFiles.map((file) => `scope: unowned file ${file}`) : [result.error ?? "Herdr correction turn failed"], error: result.error ?? (unsafe ? "unowned_source_file" : "herdr_correction_failed"), ...common };
        return { status: "completed", summary: result.output, validations: [], deviations: correctionFilesChanged.map((file) => `correction changed: ${file}`), remainingIssues: [], ...common };
      }
      if (!this.lead) throw new Error("Herdr worker context is not safely reusable; Pi Lead correction required.");
      return this.lead.execute(input);
    }
    if (!contract) throw new Error("Herdr execution requires approved execution contract.");
    validateHerdrContract(contract);
    const handles = contract.workers.map((worker) => herdrAgentHandle(input.taskId, worker.id));
    validateHerdrAgentHandles(handles);
    const baseline: WorkspaceBaseline = input.executionBaseline ?? await captureWorkspaceBaseline(input.workspaceRoot);
    if (!(await this.adapter.isAvailable())) throw new Error("Herdr is unavailable. Start Herdr before approving a multi-agent task.");
    const states = new Map<string, WorkerState>(contract.workers.map((worker) => [worker.id, "pending"]));
    const records = new Map<string, HerdrWorkerRecord>(contract.workers.map((worker) => [worker.id, { ...worker, state: "pending", model: LUNA_MAX_MODEL, thinkingLevel: LUNA_MAX_PROFILE.thinkingLevel }]));
    const results: string[] = [];
    const resultByWorker = new Map<string, string>();
    const spawned = new Set<string>();
    const emit = async () => input.onLifecycle?.({ status: "running", startedAt: new Date().toISOString(), completedAt: "", summary: "Herdr worker lifecycle update.", filesChanged: [], validations: [], deviations: [], remainingIssues: [], baseline, workers: [...records.values()] });
    await emit();
    while (results.length < contract.workers.length) {
      const ready = readyWorkers(contract.workers, states).filter((worker) => !contract.workers.some((other) => states.get(other.id) === "running" && scopesOverlap(worker.owns, other.owns)));
      if (!ready.length) { if ([...states.values()].some((state) => state === "failed")) throw new Error("Herdr execution blocked by failed worker dependency."); throw new Error("Herdr execution stalled: no schedulable workers."); }
      await Promise.all(ready.map(async (worker) => {
        const startedAt = new Date().toISOString(); states.set(worker.id, "starting"); records.set(worker.id, { ...records.get(worker.id)!, state: "starting", startedAt }); await emit(); states.set(worker.id, "running"); records.set(worker.id, { ...records.get(worker.id)!, state: "running" }); await emit();
        try { const handle = herdrAgentHandle(input.taskId, worker.id); const identity = await this.adapter.spawn(worker, input.workspaceRoot, workerPrompt(input, worker, worker.dependsOn.map((id) => resultByWorker.get(id) ?? "").filter(Boolean)), handle, async (paneId, evidence) => { records.set(worker.id, { ...records.get(worker.id)!, paneId, state: "starting", diagnostics: [evidence] }); await emit(); }, async (identity, evidence) => { records.set(worker.id, { ...records.get(worker.id)!, paneId: identity.paneId, agentHandle: identity.agentHandle, state: "running", diagnostics: [...(records.get(worker.id)?.diagnostics ?? []), evidence] }); await emit(); }); records.set(worker.id, { ...records.get(worker.id)!, paneId: identity.paneId, agentHandle: identity.agentHandle }); await emit(); spawned.add(identity.agentHandle); const result = await this.adapter.wait(identity.agentHandle); if (result.status !== "completed") { records.set(worker.id, { ...records.get(worker.id)!, ...(result.diagnostic ? { diagnostics: [result.diagnostic] } : {}) }); throw new Error(result.error ?? `Worker ${worker.id} failed`); } states.set(worker.id, "completed"); records.set(worker.id, { ...records.get(worker.id)!, state: "completed", paneId: identity.paneId, agentHandle: identity.agentHandle, completedAt: new Date().toISOString(), result: result.output }); resultByWorker.set(worker.id, `${worker.id}: ${result.output}`); results.push(`${worker.id}: ${result.output}`); await emit(); } catch (error) { states.set(worker.id, "failed"); records.set(worker.id, { ...records.get(worker.id)!, state: "failed", ...(error instanceof HerdrStartupError ? { paneId: error.paneId, ...(error.diagnostic?.agentHandle ? { agentHandle: error.diagnostic.agentHandle } : {}), ...(error.diagnostic ? { diagnostics: [error.diagnostic] } : {}) } : {}), failure: error instanceof Error ? error.message : String(error), completedAt: new Date().toISOString() }); await emit(); await Promise.all([...spawned].map((agentId) => this.adapter.stop(agentId).catch(() => undefined))); throw error; }
      }));
    }
    let status = ""; let diff = "";
    try { status = await gitStatus(input.workspaceRoot); } catch { /* non-git workspace */ }
    try { diff = await gitDiff(input.workspaceRoot, false); } catch { /* non-git workspace */ }
    const filesChanged = await changedFilesFromBaseline(input.workspaceRoot, baseline);
    const ownersByFile = Object.fromEntries(filesChanged.map((file) => [file, contract.workers.filter((worker) => worker.owns.some((scope) => scope === file || (scope.endsWith("/**") && file.startsWith(scope.slice(0, -3))))).map((worker) => worker.id)]));
    const unownedFiles = filesChanged.filter((file) => ownersByFile[file]!.length === 0);
    const ambiguousOwnerFiles = filesChanged.filter((file) => ownersByFile[file]!.length > 1);
    const scopeEvidence = { changedFiles: filesChanged, unownedFiles, ambiguousOwnerFiles, ownersByFile };
    const deviations = unownedFiles.map((file) => `unexpected: ${file}`).concat(ambiguousOwnerFiles.map((file) => `ambiguous ownership: ${file}`));
    const unownedSourceFiles = unownedFiles.filter(isSourceMutationPath);
    const summary = unownedSourceFiles.length
      ? `Execution needs attention. Files were changed outside approved worker scopes:\n${unownedSourceFiles.map((file) => `- ${file}`).join("\n")}\n\nAutomatic continuation is disabled.`
      : contract.workers.map((worker) => resultByWorker.get(worker.id)).filter(Boolean).join("\n\n");
    return { status: unownedSourceFiles.length ? "failed" : "completed", startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), summary, filesChanged, validations: [], deviations: [...deviations, diff ? "authoritative git diff captured" : "authoritative git diff unavailable"], remainingIssues: unownedSourceFiles.length ? unownedSourceFiles.map((file) => `scope: unowned source file ${file}`) : [], baseline, scopeEvidence, workers: [...records.values()], ...(unownedSourceFiles.length ? { error: "unowned_source_file" } : {}) };
  }
}

export class UnavailableHerdrAdapter implements HerdrAdapter {
  async isAvailable() { return false; }
  async spawn(_worker: HerdrWorker, _workspaceRoot: string, _prompt: string, _agentHandle: string): Promise<{ paneId: string; agentHandle: string }> { throw new Error("Herdr is unavailable. Start Herdr before approving a multi-agent task."); }
  async wait(_agentHandle: string): Promise<{ status: "completed" | "failed"; output: string; error?: string }> { throw new Error("Herdr is unavailable"); }
  async reuse(_agentHandle: string, _prompt: string, _paneId?: string): Promise<{ status: "completed" | "failed"; output: string; error?: string }> { throw new Error("Herdr is unavailable"); }
  async stop() {}
}
