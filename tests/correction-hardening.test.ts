import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore } from "../src/task-store.js";
import { ReviewOrchestrator } from "../src/service/review.js";
import type { CorrectionAttempt, ExecutionResult, PlannerTask, ReviewFinding } from "../src/types.js";

const finding: ReviewFinding = { severity: "major", file: "docs/owner.md", issue: "fix" };
const baseline = { capturedAt: "before", files: { "docs/owner.md": "A" } };
const scopeEvidence = { changedFiles: ["docs/owner.md"], ownersByFile: { "docs/owner.md": ["owner"] }, unownedFiles: [], ambiguousOwnerFiles: [] };

async function setup(withFinding = true, route: "pi-lead" | "herdr-worker" = "pi-lead", herdr = false) {
  const dir = await mkdtemp(join(tmpdir(), "pi-correction-hardening-"));
  const store = new TaskStore(dir); const task = await store.createTask(dir, "fix");
  await store.submitPlan(task.id, { summary: "fix", planMarkdown: "fix", filesToInspect: [], acceptanceCriteria: [], tests: [], risks: [], openQuestions: [], ...(herdr ? { execution: { mode: "herdr" as const, workerModel: "luna-max" as const, workers: [{ id: "owner", objective: "fix", owns: ["docs/owner.md"], dependsOn: [] }] } } : {}) });
  await store.updateChat(task.id, { targetId: "target", temporary: true, personalized: true, reasoning: "high" });
  await store.transition(task.id, "approved"); await store.claimExecution(task.id);
  await store.saveExecution(task.id, { status: "completed", startedAt: "", completedAt: "", summary: "done", filesChanged: ["docs/owner.md"], validations: [], deviations: [], remainingIssues: [], baseline, ...(herdr ? { workers: [{ id: "owner", objective: "fix", owns: ["docs/owner.md"], dependsOn: [], state: "completed" as const, model: "openai-codex/gpt-5.6-luna" as const, thinkingLevel: "max" as const, agentHandle: "handle", paneId: "pane" }] } : {}) });
  if (!withFinding) return { dir, store, task: await store.getTask(task.id), attempt: undefined };
  await store.startReview(task.id, 3); await store.saveReviewResult(task.id, 1, "changes_requested", "fix", [finding]);
  const claimed = await store.claimCorrection(task.id, { round: 1, route, workerId: "owner", agentHandle: "handle", paneId: "pane", correctionRoundBaseline: baseline });
  assert.ok(claimed?.correctionAttempt); return { dir, store, task: await store.getTask(task.id), attempt: claimed!.correctionAttempt! };
}

function validResult(attempt: CorrectionAttempt, filesChanged = ["docs/owner.md"]): ExecutionResult {
  return { status: "completed", startedAt: "", completedAt: "", summary: "corrected", filesChanged, validations: [], deviations: [], remainingIssues: [], round: attempt.round, correctionAttemptId: attempt.attemptId, correctionAttempt: { ...attempt, status: "completed", correctionFilesChanged: filesChanged, scopeEvidence: { ...scopeEvidence, changedFiles: filesChanged }, ...(attempt.route === "herdr-worker" ? { herdrTurn: { agentHandle: attempt.agentHandle!, paneId: attempt.paneId!, before: { name: attempt.agentHandle!, paneId: attempt.paneId!, stateChangeSeq: 10 }, after: { name: attempt.agentHandle!, paneId: attempt.paneId!, stateChangeSeq: 12 }, prompt: { operation: "agent prompt", args: ["<correction-prompt>"], exitCode: 0, stdout: "", stderr: "", agentHandle: attempt.agentHandle!, paneId: attempt.paneId! }, turnObserved: true } } : {}), proof: { route: attempt.route, attemptId: attempt.attemptId, round: attempt.round, matched: true } } };
}

async function runHerdrCorrection(mutate: (result: ExecutionResult) => void, filesChanged: string[] = []) {
  const { dir, store, task } = await setup(false, "herdr-worker", true); const calls: string[] = [];
  const orch = new ReviewOrchestrator({ store, browser: { sendReviewPrompt: async () => { calls.push("review"); if (calls.length === 1) await store.saveReviewResult(task.id, 1, "changes_requested", "fix", [finding]); else await store.saveReviewResult(task.id, 2, "approved", "ok", []); } } as never, isInfrastructureReady: async () => true, maxReviewIterations: 3, reviewTimeoutMs: 1000, getExecutor: () => ({ execute: async (): Promise<ExecutionResult> => { const result = validResult((await store.getTask(task.id)).correctionAttempt!, filesChanged); mutate(result); return result; } }) });
  const run = orch.retryReview(task.id); for (let i = 0; i < 100 && calls.length < 1; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setTimeout(resolve, 350)); return { dir, store, task, calls, run };
}

test("invalid Herdr proof blocks review two through orchestration", async () => {
  const { dir, store, task, calls, run } = await runHerdrCorrection((result) => { result.correctionAttempt!.herdrTurn!.after!.stateChangeSeq = 10; result.correctionAttempt!.herdrTurn!.turnObserved = false; result.correctionAttempt!.proof!.matched = false; });
  try { assert.equal(calls.length, 1); assert.notEqual((await store.getTask(task.id)).review?.status, "correction_completed"); assert.equal((await store.getTask(task.id)).review?.iteration, 1); await run; } finally { await rm(dir, { recursive: true, force: true }); }
});

test("valid Herdr proof starts exactly one review two", async () => {
  const { dir, store, calls, run } = await runHerdrCorrection(() => {}, []);
  try { await run; assert.equal(calls.length, 2); assert.equal((await store.getTask((await store.listTasks())[0]!.id)).review?.iteration, 2); } finally { await rm(dir, { recursive: true, force: true }); }
});

test("unowned source correction blocks review two", async () => {
  const { dir, store, task, calls, run } = await runHerdrCorrection((result) => { result.filesChanged = ["src/runtime.ts"]; result.correctionAttempt!.scopeEvidence = { changedFiles: ["src/runtime.ts"], ownersByFile: { "src/runtime.ts": [] }, unownedFiles: ["src/runtime.ts"], ambiguousOwnerFiles: [] }; result.correctionAttempt!.proof!.matched = true; });
  try { assert.equal(calls.length, 1); assert.notEqual((await store.getTask(task.id)).review?.status, "correction_completed"); assert.equal((await store.getTask(task.id)).review?.iteration, 1); await run; } finally { await rm(dir, { recursive: true, force: true }); }
});

test("valid zero-change Herdr turn reaches review two", async () => {
  const { dir, store, calls, run } = await runHerdrCorrection(() => {}, []);
  try { await run; assert.equal(calls.length, 2); } finally { await rm(dir, { recursive: true, force: true }); }
});

test("TaskStore rejects stale and duplicate correction results", async () => {
  const { dir, store, task, attempt } = await setup();
  try {
    await assert.rejects(() => store.saveCorrectionResult(task.id, validResult({ ...attempt!, attemptId: "stale" })), /proof missing/);
    assert.equal((await store.getTask(task.id)).correctionAttempt?.attemptId, attempt!.attemptId);
    await store.saveCorrectionResult(task.id, validResult(attempt!));
    await assert.rejects(() => store.saveCorrectionResult(task.id, validResult(attempt!)), /Cannot save correction/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("TaskStore rejects each core Herdr completion invariant", async () => {
  const cases: Record<string, (result: ExecutionResult, attempt: CorrectionAttempt) => void> = {
    attemptId: (r) => { r.correctionAttemptId = "wrong"; }, round: (r) => { r.round = 9; }, route: (r) => { r.correctionAttempt!.route = "pi-lead"; },
    worker: (r) => { r.correctionAttempt!.workerId = "wrong"; }, handle: (r) => { r.correctionAttempt!.agentHandle = "wrong"; }, pane: (r) => { r.correctionAttempt!.paneId = "wrong"; },
    proof: (r) => { delete r.correctionAttempt!.proof; }, evidence: (r) => { delete r.correctionAttempt!.scopeEvidence; }, baseline: (r) => { delete r.correctionAttempt!.correctionRoundBaseline; }
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const { dir, store, task, attempt } = await setup(true, "herdr-worker"); try { const result = validResult(attempt!); mutate(result, attempt!); await assert.rejects(() => store.saveCorrectionResult(task.id, result), /proof missing/, name); } finally { await rm(dir, { recursive: true, force: true }); }
    assert.ok(name);
  }
});

test("interrupted claimed and dispatched attempts recover without replay", async () => {
  for (const state of ["claimed", "dispatched"] as const) {
    const { dir, store, task } = await setup(); try {
      if (state === "dispatched") await store.markCorrectionDispatched(task.id);
      const recovered = await store.recoverInterruptedCorrections(); assert.equal(recovered.length, 1);
      const current = await store.getTask(task.id); assert.equal(current.correctionAttempt?.status, "ambiguous"); assert.equal(current.review?.status, "failed");
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test("valid persisted correction allows exactly one next review", async () => {
  const { dir, store, task } = await setup(false); const calls: string[] = [];
  try {
    const orch = new ReviewOrchestrator({ store, browser: { sendReviewPrompt: async (t: PlannerTask) => { calls.push(t.chat?.targetId ?? ""); } } as never, isInfrastructureReady: async () => true, maxReviewIterations: 3, reviewTimeoutMs: 1000,
      getExecutor: () => ({ execute: async (): Promise<ExecutionResult> => validResult((await store.getTask(task.id)).correctionAttempt!, []) }) });
    const run = orch.retryReview(task.id);
    for (let i = 0; i < 20 && calls.length < 1; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    await store.saveReviewResult(task.id, 1, "changes_requested", "fix", [finding]);
    for (let i = 0; i < 100 && calls.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 2); assert.equal((await store.getTask(task.id)).review?.status, "reviewing");
    await store.saveReviewResult(task.id, 2, "approved", "ok", []); assert.equal(await run, "done");
    assert.equal(calls.length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
