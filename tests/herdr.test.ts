import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
import { HERDR_AGENT_NAME_MAX_LENGTH, HerdrCliAdapter, HerdrExecutor, LUNA_MAX_MODEL, LUNA_MAX_PROFILE, extractHerdrIdentity, herdrAgentHandle, herdrAgentStartArgs, isSourceMutationPath, parseAgentStart, parseAgentState, validateHerdrAgentHandles, type HerdrAdapter } from "../src/herdr.js";
import type { PlannerExecutorInput } from "../src/executor.js";
import type { HerdrWorker } from "../src/types.js";

class FakeHerdr implements HerdrAdapter {
  spawned: HerdrWorker[] = []; prompts: string[] = [];
  async isAvailable() { return true; }
  async spawn(worker: HerdrWorker, _root: string, prompt: string, handle: string): Promise<{ paneId: string; agentHandle: string }> { this.spawned.push(worker); this.prompts.push(prompt); return { paneId: `pane-${worker.id}`, agentHandle: handle }; }
  async wait(agentId: string): Promise<{ status: "completed" | "failed"; output: string; error?: string }> { return { status: "completed", output: `${agentId} done` }; }
  async reuse(agentId: string, prompt: string): Promise<{ status: "completed" | "failed"; output: string; error?: string; turn: NonNullable<Awaited<ReturnType<HerdrAdapter["reuse"]>>["turn"]> }> { this.prompts.push(prompt); return { status: "completed", output: `${agentId} reused`, turn: { agentHandle: agentId, paneId: "pane-one", before: { name: agentId, paneId: "pane-one", stateChangeSeq: 10, revision: 1, interactiveReady: true }, after: { name: agentId, paneId: "pane-one", stateChangeSeq: 12, revision: 1, interactiveReady: true }, prompt: { operation: "agent prompt", args: ["agent", "prompt", agentId, "<correction-prompt>", "--wait"], exitCode: 0, stdout: "", stderr: "", agentHandle: agentId, paneId: "pane-one" }, turnObserved: true } }; }
  async stop(_agentId: string): Promise<void> {}
}
test("Herdr uses deterministic task-scoped runtime handles", () => {
  const handle = herdrAgentHandle("aaaaaaaa-1111", "readme/v22");
  assert.equal(handle, "pp-aaaaaaaa-readme-v-" + handle.slice(-8));
  assert.ok(handle.length <= HERDR_AGENT_NAME_MAX_LENGTH);
  assert.notEqual(herdrAgentHandle("aaaaaaaa-1111", "readme"), herdrAgentHandle("bbbbbbbb-2222", "readme"));
  assert.throws(() => validateHerdrAgentHandles(["pp-same-12345678", "pp-same-12345678"]), /collision/);
  for (const handle of [herdrAgentHandle("f692cf69-27a6-4ba8-9a5d-1df0a0dd3e50", "readme-v22-note"), herdrAgentHandle("f692cf69-27a6-4ba8-9a5d-1df0a0dd3e50", "roadmap-v22-live-acceptance"), herdrAgentHandle("task", "UPPER / invalid !!!")]) assert.match(handle, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.match(herdrAgentHandle("task", "UPPER / invalid !!!"), /upper-in-/);
  assert.match(herdrAgentHandle("task", "!!!"), /-worker-/);
});

test("Luna Max profile and Herdr start arguments are fixed", () => {
  assert.deepEqual(LUNA_MAX_PROFILE, { displayName: "Luna Max", provider: "openai-codex", model: "gpt-5.6-luna", modelId: "openai-codex/gpt-5.6-luna", thinkingLevel: "max" });
  assert.deepEqual(herdrAgentStartArgs("workspace:tab:pane", "pp-aaaaaaaa-readme-v2-12345678"), ["agent", "start", "pp-aaaaaaaa-readme-v2-12345678", "--kind", "pi", "--pane", "workspace:tab:pane", "--", "--model", "openai-codex/gpt-5.6-luna", "--thinking", "max", "--no-session"]);
  assert.doesNotThrow(() => validateHerdrAgentHandles(["pp-aaaaaaaa-readme-v2-12345678"]));
});

test("Herdr parses and validates live agent-start identity", () => {
  const output = JSON.stringify({ id: "cli:agent:start", result: { agent: { agent: "pi", name: "pp-aaaaaaaa-readme-v2-12345678", pane_id: "wP:p9" }, argv: ["pi", "--model", LUNA_MAX_MODEL, "--thinking", "max", "--no-session"] } });
  assert.deepEqual(parseAgentStart(output, "pp-aaaaaaaa-readme-v2-12345678", "wP:p9"), { agentHandle: "pp-aaaaaaaa-readme-v2-12345678", paneId: "wP:p9" });
  assert.equal(extractHerdrIdentity(output, "pane_id"), "wP:p9");
  assert.equal(extractHerdrIdentity(output, "agent_id"), undefined);
  assert.throws(() => parseAgentStart(JSON.stringify({ id: "cli:agent:start", result: { agent: { pane_id: "wP:p9" } } }), "expected", "wP:p9"), /incomplete/);
  assert.throws(() => parseAgentStart(output, "wrong", "wP:p9"), /mismatched handle/);
  assert.throws(() => parseAgentStart(output, "pp-aaaaaaaa-readme-v2-12345678", "wP:p8"), /mismatched pane/);
});

test("scope safety classifies source violations while excluding documentation", () => {
  assert.equal(isSourceMutationPath("backend/api.ts"), true);
  assert.equal(isSourceMutationPath("docs/plan.md"), false);
  assert.equal(isSourceMutationPath("README.md"), false);
});

const input = (workers: HerdrWorker[]): PlannerExecutorInput => ({ taskId: "task", request: "feature", workspaceRoot: "/tmp", approvedRevision: 2, instructions: "", plan: { summary: "x", planMarkdown: "x", filesToInspect: [], acceptanceCriteria: [], tests: [], risks: [], openQuestions: [], submittedAt: "now", execution: { mode: "herdr", workerModel: "luna-max", workers }, context: { methods: ["design-thinking"], skills: ["design-method"] } } });
test("Herdr executor dispatches independent workers then dependencies", async () => { const herdr = new FakeHerdr(); const result = await new HerdrExecutor(herdr).execute(input([{ id: "backend", objective: "backend", owns: ["backend/**"], dependsOn: [] }, { id: "frontend", objective: "frontend", owns: ["frontend/**"], dependsOn: [] }, { id: "tests", objective: "tests", owns: ["tests/**"], dependsOn: ["backend", "frontend"] }])); assert.deepEqual(herdr.spawned.map((x) => x.id), ["backend", "frontend", "tests"]); assert.equal(result.workers?.every((x) => x.model === LUNA_MAX_MODEL && x.thinkingLevel === "max" && x.state === "completed"), true); assert.match(herdr.prompts[0]!, /do not spawn agents/i); assert.match(herdr.prompts[0]!, /design-thinking/); });
test("baseline excludes untouched dirty source while retaining worker doc change", async () => {
  const root = await mkdtemp(join("/tmp", "pi-herdr-baseline-"));
  try {
    await exec("git", ["init", "-q"], { cwd: root }); await writeFile(join(root, "src.ts"), "A", "utf8"); await writeFile(join(root, "README.md"), "old", "utf8"); await exec("git", ["add", "."], { cwd: root }); await writeFile(join(root, "src.ts"), "dirty", "utf8");
    const adapter = new FakeHerdr(); adapter.spawn = async (worker, workspace, _prompt, handle) => { await writeFile(join(workspace, "README.md"), "new", "utf8"); return { paneId: "pane", agentHandle: handle }; };
    const result = await new HerdrExecutor(adapter).execute({ ...input([{ id: "docs", objective: "docs", owns: ["README.md"], dependsOn: [] }]), workspaceRoot: root });
    assert.equal(result.status, "completed"); assert.deepEqual(result.filesChanged, ["README.md"]); assert.deepEqual(result.scopeEvidence?.unownedFiles, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("worker mutation of pre-existing dirty source remains fail-closed", async () => {
  const root = await mkdtemp(join("/tmp", "pi-herdr-baseline-"));
  try {
    await exec("git", ["init", "-q"], { cwd: root }); await writeFile(join(root, "src.ts"), "A", "utf8"); await writeFile(join(root, "README.md"), "old", "utf8"); await exec("git", ["add", "."], { cwd: root }); await writeFile(join(root, "src.ts"), "dirty", "utf8");
    const adapter = new FakeHerdr(); adapter.spawn = async (worker, workspace, _prompt, handle) => { await writeFile(join(workspace, "src.ts"), "mutated", "utf8"); return { paneId: "pane", agentHandle: handle }; };
    const result = await new HerdrExecutor(adapter).execute({ ...input([{ id: "docs", objective: "docs", owns: ["README.md"], dependsOn: [] }]), workspaceRoot: root });
    assert.equal(result.status, "failed"); assert.deepEqual(result.filesChanged, ["src.ts"]); assert.deepEqual(result.scopeEvidence?.unownedFiles, ["src.ts"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unowned source change fails execution after authoritative scope check", async () => {
  const root = await mkdtemp(join("/tmp", "pi-herdr-scope-"));
  try {
    await exec("git", ["init", "-q"], { cwd: root });
    const adapter = new FakeHerdr();
    adapter.spawn = async (worker, workspace, _prompt, handle) => { await writeFile(join(workspace, "rogue.ts"), "export const rogue = true;", "utf8"); adapter.spawned.push(worker); return { paneId: "pane", agentHandle: handle }; };
    const result = await new HerdrExecutor(adapter).execute({ ...input([{ id: "owned", objective: "owned", owns: ["owned/**"], dependsOn: [] }]), workspaceRoot: root });
    assert.equal(result.status, "failed"); assert.deepEqual(result.scopeEvidence?.unownedFiles, ["rogue.ts"]); assert.match(result.summary, /Automatic continuation is disabled/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Herdr executor fails before spawn when unavailable", async () => { const herdr = new FakeHerdr(); herdr.isAvailable = async () => false; await assert.rejects(() => new HerdrExecutor(herdr).execute(input([{ id: "one", objective: "one", owns: ["one/**"], dependsOn: [] }])), /unavailable/); assert.equal(herdr.spawned.length, 0); });

test("dependency prompts and summaries stay in contract order despite completion timing", async () => {
  const herdr = new FakeHerdr();
  herdr.wait = async (id: string) => { await new Promise((resolve) => setTimeout(resolve, id.includes("backend") ? 15 : 1)); return { status: "completed" as const, output: `${id} output` }; };
  const snapshots: string[][] = [];
  const result = await new HerdrExecutor(herdr).execute({ ...input([{ id: "backend", objective: "backend", owns: ["backend/**"], dependsOn: [] }, { id: "frontend", objective: "frontend", owns: ["frontend/**"], dependsOn: [] }, { id: "tests", objective: "tests", owns: ["tests/**"], dependsOn: ["backend", "frontend"] }]), onLifecycle: async (execution) => { snapshots.push(execution.workers?.map((worker) => `${worker.id}:${worker.state}`) ?? []); } });
  assert.match(herdr.prompts[2]!, /pp-task-backend-[a-f0-9]{8} output.*pp-task-frontend-[a-f0-9]{8} output/s);
  assert.ok(result.summary.indexOf("pp-task-backend-") < result.summary.indexOf("pp-task-frontend-"));
  assert.ok(snapshots.some((snapshot) => snapshot.includes("backend:pending")));
  assert.ok(snapshots.some((snapshot) => snapshot.includes("backend:running")));
  assert.ok(snapshots.some((snapshot) => snapshot.includes("backend:completed")));
});

test("worker failure stops every already-started agent", async () => {
  const herdr = new FakeHerdr(); const stopped: string[] = [];
  herdr.stop = async (id: string) => { stopped.push(id); };
  herdr.wait = async (id: string) => id.includes("b") ? { status: "failed" as const, output: "", error: "crash" } : { status: "completed" as const, output: "ok" };
  const snapshots: string[][] = [];
  await assert.rejects(() => new HerdrExecutor(herdr).execute({ ...input([{ id: "a", objective: "a", owns: ["a/**"], dependsOn: [] }, { id: "b", objective: "b", owns: ["b/**"], dependsOn: [] }]), onLifecycle: async (execution) => { snapshots.push(execution.workers?.map((worker) => `${worker.id}:${worker.state}`) ?? []); } }), /crash/);
  assert.deepEqual(stopped.sort(), ["pp-task-a-208fcc98", "pp-task-b-1f3846c5"]);
  assert.ok(snapshots.some((snapshot) => snapshot.includes("b:failed")));
});

test("correction round reuses exact Herdr agent without spawning", async () => {
  const herdr = new FakeHerdr();
  const result = await new HerdrExecutor(herdr).execute({ ...input([{ id: "one", objective: "one", owns: ["one/**"], dependsOn: [] }]), round: 1, correctionWorkerId: "one", correctionAgentId: "agent-one", correctionPaneId: "pane-one", correctionObjective: "fix one", correctionOwnership: ["one/**"] });
  assert.equal(result.summary, "agent-one reused"); assert.equal(herdr.spawned.length, 0); assert.match(herdr.prompts[0]!, /fix one/); assert.match(herdr.prompts[0]!, /one\/\*\*/);
});

test("Herdr CLI adapter proves live-shaped get-prompt-get turn", async () => {
  const dir = await mkdtemp(join("/tmp", "pi-herdr-cli-")); const state = join(dir, "state"); const command = join(dir, "herdr");
  try {
    await writeFile(state, "10", "utf8"); await writeFile(command, `#!/bin/sh\nif [ "$1/$2" = "agent/get" ]; then s=$(cat "${state}"); printf '{"id":"cli:agent:get","result":{"agent":{"agent":"pi","agent_status":"idle","interactive_ready":true,"name":"worker-handle","pane_id":"pane-1","revision":1,"state_change_seq":%s},"type":"agent_info"}}\\n' "$s"; elif [ "$1/$2" = "agent/prompt" ]; then echo 12 > "${state}"; printf '{"id":"cli:agent:prompt","result":{"agent":{"agent":"pi","agent_status":"done","interactive_ready":true,"name":"worker-handle","pane_id":"pane-1","revision":1,"state_change_seq":12},"type":"agent_prompted"}}\\n'; fi\n`, "utf8"); await chmod(command, 0o755);
    const result = await new HerdrCliAdapter(command).reuse("worker-handle", "secret correction", "pane-1");
    assert.equal(result.status, "completed"); assert.equal(result.turn?.turnObserved, true); assert.equal(result.turn?.before.stateChangeSeq, 10); assert.equal(result.turn?.after?.stateChangeSeq, 12); assert.equal(result.turn?.prompt.args[3], "<correction-prompt>"); assert.equal(result.turn?.prompt.stdout.includes("secret correction"), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Herdr CLI adapter fails closed on post-turn identity and get failures", async () => {
  for (const mode of ["handle", "pane", "get-failure"] as const) {
    const dir = await mkdtemp(join("/tmp", "pi-herdr-failure-")); const state = join(dir, "state"); const command = join(dir, "herdr");
    try {
      await writeFile(state, "10", "utf8"); await writeFile(command, `#!/bin/sh\nif [ "$1/$2" = "agent/get" ]; then s=$(cat "${state}"); if [ "$s" = "12" ] && [ "${mode}" = "get-failure" ]; then exit 1; fi; n=worker-handle; p=pane-1; if [ "$s" = "12" ] && [ "${mode}" = "handle" ]; then n=other-handle; fi; if [ "$s" = "12" ] && [ "${mode}" = "pane" ]; then p=other-pane; fi; printf '{"result":{"agent":{"name":"%s","pane_id":"%s","interactive_ready":true,"state_change_seq":%s,"revision":1}}}\\n' "$n" "$p" "$s"; elif [ "$1/$2" = "agent/prompt" ]; then echo 12 > "${state}"; printf '{"id":"cli:agent:prompt","result":{"agent":{"name":"worker-handle","pane_id":"pane-1","interactive_ready":true,"state_change_seq":12,"revision":1}}}\\n'; fi\n`, "utf8"); await chmod(command, 0o755);
      const result = await new HerdrCliAdapter(command).reuse("worker-handle", "fix", "pane-1"); assert.equal(result.status, "failed"); assert.equal(result.turn?.turnObserved, false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test("Herdr agent state validates identity and exposes monotonic turn evidence fields", () => {
  const state = parseAgentState(JSON.stringify({ result: { agent: { name: "agent-one", pane_id: "pane-one", agent_status: "idle", state_change_seq: 12, revision: 1, interactive_ready: true } } }), "agent-one", "pane-one");
  assert.deepEqual(state, { name: "agent-one", paneId: "pane-one", agentStatus: "idle", stateChangeSeq: 12, revision: 1, interactiveReady: true });
  assert.throws(() => parseAgentState(JSON.stringify({ result: { agent: { name: "other", pane_id: "pane-one" } } }), "agent-one", "pane-one"), /mismatched handle/);
  assert.throws(() => parseAgentState(JSON.stringify({ result: { agent: { name: "agent-one", pane_id: "other" } } }), "agent-one", "pane-one"), /mismatched pane/);
});

test("reused Herdr prompt gives correction instructions semantic precedence", async () => {
  const herdr = new FakeHerdr();
  const result = await new HerdrExecutor(herdr).execute({ ...input([{ id: "one", objective: "Create docs/owner.md with EXACTLY: pending", owns: ["docs/owner.md"], dependsOn: [] }]), round: 1, correctionWorkerId: "one", correctionAgentId: "agent-one", correctionPaneId: "pane-one", correctionObjective: "Create docs/owner.md with EXACTLY: pending", correctionOwnership: ["docs/owner.md"], instructions: "Replace pending with verified." });
  assert.equal(result.status, "completed");
  const prompt = herdr.prompts[0]!;
  assert.match(prompt, /Create docs\/owner\.md with EXACTLY: pending/);
  assert.match(prompt, /Replace pending with verified\./);
  assert.match(prompt, /docs\/owner\.md/);
  assert.match(prompt, /\nCORRECTION TURN\n/);
  assert.match(prompt, /\nCurrent correction instructions:\n/);
  assert.doesNotMatch(prompt, /\\nCORRECTION TURN\\n/);
  assert.doesNotMatch(prompt, /\\nCurrent correction instructions:\\n/);
  assert.match(prompt, /current correction instructions.*SUPERSEDE.*conflicting.*original objective/i);
  assert.match(prompt, /Do not replay.*original task/i);
  assert.match(prompt, /Do not restore or preserve.*old target state/i);
});

test("reused Herdr prompt preserves original context for non-conflicting correction", async () => {
  const herdr = new FakeHerdr();
  const result = await new HerdrExecutor(herdr).execute({ ...input([{ id: "one", objective: "Create docs/owner.md", owns: ["docs/owner.md"], dependsOn: [] }]), round: 1, correctionWorkerId: "one", correctionAgentId: "agent-one", correctionPaneId: "pane-one", correctionObjective: "Create docs/owner.md", correctionOwnership: ["docs/owner.md"], instructions: "Fix typo in docs/owner.md." });
  assert.equal(result.status, "completed");
  const prompt = herdr.prompts[0]!;
  assert.match(prompt, /Create docs\/owner\.md/);
  assert.match(prompt, /Fix typo in docs\/owner\.md\./);
  assert.match(prompt, /historical context/i);
  assert.match(prompt, /Ownership: docs\/owner\.md/);
});

test("correction with successful CLI but unchanged state is not completed", async () => {
  const herdr = new FakeHerdr(); herdr.reuse = async (agentId, prompt) => ({ status: "completed", output: "ack", turn: { agentHandle: agentId, paneId: "pane-one", before: { name: agentId, paneId: "pane-one", stateChangeSeq: 10 }, after: { name: agentId, paneId: "pane-one", stateChangeSeq: 10 }, prompt: { operation: "agent prompt", args: ["<correction-prompt>"], exitCode: 0, stdout: "", stderr: "" }, turnObserved: false } });
  const result = await new HerdrExecutor(herdr).execute({ ...input([{ id: "one", objective: "one", owns: ["one/**"], dependsOn: [] }]), round: 1, correctionWorkerId: "one", correctionAgentId: "agent-one", correctionPaneId: "pane-one" });
  assert.equal(result.status, "failed"); assert.equal(result.herdrTurn?.turnObserved, false);
});

test("correction round delegates to Pi Lead without spawning Herdr worker", async () => {
  const herdr = new FakeHerdr(); const lead = { execute: async () => ({ status: "completed" as const, startedAt: "", completedAt: "", summary: "lead", filesChanged: [], validations: [], deviations: [], remainingIssues: [] }) };
  const result = await new HerdrExecutor(herdr, lead).execute({ ...input([{ id: "one", objective: "one", owns: ["one/**"], dependsOn: [] }]), round: 1 });
  assert.equal(result.summary, "lead"); assert.equal(herdr.spawned.length, 0);
});
