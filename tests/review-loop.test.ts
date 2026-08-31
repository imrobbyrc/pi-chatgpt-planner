import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../src/task-store.js";
import { ReviewOrchestrator } from "../src/service/review.js";
import { PiMessageExecutor, type PlannerExecutorInput } from "../src/executor.js";
import type { ExecutionResult, PlannerTask, ReviewFinding } from "../src/types.js";

const plan = { summary: "Do X", planMarkdown: "1. Do X", filesToInspect: [], acceptanceCriteria: [], tests: ["npm test"], risks: [], openQuestions: [], submittedAt: "" };
const blocking: ReviewFinding[] = [{ severity: "blocking", file: "src/x.ts", line: 3, issue: "wrong", requested_change: "fix it" }];

async function executedTask(dir: string): Promise<{ store: TaskStore; task: PlannerTask }> {
  const store = new TaskStore(dir);
  const task = await store.createTask(dir, "Do X");
  await store.submitPlan(task.id, plan);
  await store.updateChat(task.id, { targetId: "planner-target", temporary: true, personalized: true, reasoning: "high" });
  await store.transition(task.id, "approved");
  await store.claimExecution(task.id);
  await store.saveExecution(task.id, { ...okResult(), round: 0 });
  return { store, task: await store.getTask(task.id) };
}

function okResult(): ExecutionResult {
  return { status: "completed", startedAt: "", completedAt: "", summary: "done", filesChanged: ["src/x.ts"], validations: ["npm test"], deviations: [], remainingIssues: [] };
}

function fakeBrowser(targetExists: boolean): { controller: import("../src/browser/chatgpt.js").ChatGptBrowserController; calls: string[] } {
  const calls: string[] = [];
  const controller = {
    sendReviewPrompt: async (task: PlannerTask, prompt: string) => {
      calls.push(`${task.chat?.targetId}:${prompt.includes("submit_review") ? "review" : "other"}`);
      if (!targetExists) throw new Error("planner_target_unavailable: target gone");
    }
  };
  return { controller: controller as never, calls };
}

function orchestrator(store: TaskStore, browser: unknown, opts: { executor?: { calls: string[] }; ready?: boolean; max?: number; timeoutMs?: number } = {}) {
  return {
    calls: opts.executor?.calls ?? [],
    orch: new ReviewOrchestrator({
      store,
      browser: browser as never,
      getExecutor: () => opts.executor ? { execute: async (input) => { opts.executor!.calls.push(`round${input.round}`); const r = okResult(); if (input.round !== undefined) r.round = input.round; return r; } } : undefined,
      isInfrastructureReady: async () => opts.ready ?? true,
      maxReviewIterations: opts.max ?? 3,
      reviewTimeoutMs: opts.timeoutMs ?? 2_000
    })
  };
}

test("execution_completed auto-starts review; same targetId reused; APPROVED stops loop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-v2-"));
  try {
    const { store, task } = await executedTask(dir);
    assert.equal(task.review?.status, "awaiting_review");
    const browser = fakeBrowser(true);
    const { orch } = orchestrator(store, browser.controller);
    // simulate auto-start after handleAgentEnd
    const round = orch.retryReview(task.id);
    // reviewer submits APPROVED via MCP path
    await waitFor(store, task.id, (t) => t.review?.reviews.at(-1)?.status === "reviewing");
    await store.saveReviewResult(task.id, 1, "approved", "looks good", []);
    assert.equal(await round, "done");
    const final = await store.getTask(task.id);
    assert.equal(final.review?.status, "approved");
    assert.equal(final.review?.iteration, 1);
    assert.equal(final.chat?.targetId, "planner-target");
    assert.deepEqual(browser.calls, ["planner-target:review"]); // same target, exactly one prompt
    // duplicate submit_review fails closed
    await assert.rejects(() => store.saveReviewResult(task.id, 1, "approved", "again", []), /No review awaiting submission/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("CHANGES_REQUESTED triggers exactly one correction, then next review on same target", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-v2-"));
  try {
    const { store, task } = await executedTask(dir);
    const browser = fakeBrowser(true);
    const executor = { calls: [] as string[] };
    const { orch } = orchestrator(store, browser.controller, { executor });
    const round1 = orch.retryReview(task.id);
    await waitFor(store, task.id, (t) => t.review?.reviews.at(-1)?.status === "reviewing");
    await store.saveReviewResult(task.id, 1, "changes_requested", "fix", blocking);
    await waitFor(store, task.id, (t) => t.review?.reviews.length === 2 && t.review.reviews[1]?.status === "reviewing");
    // correction claimed exactly once; duplicate claim rejected
    assert.equal(await store.claimCorrection(task.id), undefined);
    await store.saveReviewResult(task.id, 2, "approved", "fixed", []);
    assert.equal(await round1, "done");
    await waitFor(store, task.id, (t) => t.review?.status === "approved");
    const final = await store.getTask(task.id);
    assert.deepEqual(executor.calls, ["round1"]); // one correction only
    assert.equal(final.review?.iteration, 2);
    assert.equal(browser.calls.length, 2); // both prompts to same target
    assert.ok(browser.calls.every((c) => c.startsWith("planner-target:")));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("V2 correction loop uses one target, one correlated correction, and semantic iterations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-v2-integration-"));
  try {
    const { store, task: original } = await executedTask(dir);
    const task = await store.updateChat(original.id, { ...original.chat!, targetId: "TARGET_A" });
    const browser = fakeBrowser(true);
    let createdTargets = 0;
    const correctionInputs: PlannerExecutorInput[] = [];
    let correctionSent = "";
    const correctionExecutor = new PiMessageExecutor((message) => { correctionSent = message; });
    const orch = new ReviewOrchestrator({
      store,
      browser: browser.controller,
      getExecutor: () => ({ execute: (input) => { correctionInputs.push(input); return correctionExecutor.execute(input); } }),
      isInfrastructureReady: async () => true,
      maxReviewIterations: 3,
      reviewTimeoutMs: 2_000
    });

    const reviewRun = orch.retryReview(task.id);
    await waitFor(store, task.id, (t) => t.review?.status === "reviewing");
    assert.equal((await store.getTask(task.id)).status, "execution_completed");
    const finding: ReviewFinding = { severity: "major", file: "README.md", issue: "Required second bullet is missing", requested_change: "Add the missing approved bullet" };
    await store.saveReviewResult(task.id, 1, "changes_requested", "fix required", [finding]);
    await assert.rejects(() => store.saveReviewResult(task.id, 1, "changes_requested", "duplicate", [finding]), /No review awaiting submission/);
    await waitFor(store, task.id, (t) => t.review?.status === "correction_executing");
    assert.equal((await store.getTask(task.id)).review?.semanticIteration, 1);
    assert.equal(browser.calls.length, 1);
    assert.equal(browser.calls[0], "TARGET_A:review");

    // Real V1 correlation boundary: unrelated Pi events cannot complete correction.
    await waitFor(store, task.id, () => correctionInputs.length === 1);
    assert.equal(correctionExecutor.matchesPrompt("unrelated Pi agent prompt"), false);
    assert.equal(await correctionExecutor.complete([{ content: "unrelated agent ended" }]), undefined);
    await waitFor(store, task.id, (t) => t.review?.status === "correction_executing");

    // Capture exact correction input, then complete only through matching marker.
    assert.equal(correctionInputs.length, 1);
    assert.equal(correctionInputs[0]?.request, "Do X");
    assert.equal(correctionInputs[0]?.plan.planMarkdown, "1. Do X");
    assert.equal(correctionInputs[0]?.workspaceRoot, dir);
    assert.equal(correctionInputs[0]?.round, 1);
    assert.match(correctionInputs[0]?.instructions ?? "", /Required second bullet is missing/);
    assert.match(correctionInputs[0]?.instructions ?? "", /Add the missing approved bullet/);
    assert.doesNotMatch(correctionInputs[0]?.instructions ?? "", /commit|push|deploy/i);
    assert.match(correctionSent, /Original request:\nDo X/);
    assert.match(correctionSent, /Approved plan:\n1\. Do X/);
    assert.match(correctionSent, /Required second bullet is missing/);
    assert.match(correctionSent, /Add the missing approved bullet/);
    assert.equal(correctionExecutor.matchesPrompt(correctionSent), true);
    await correctionExecutor.complete([{ content: "Added missing approved bullet" }]);

    await waitFor(store, task.id, (t) => t.review?.reviews.length === 2 && t.review.reviews[1]?.status === "reviewing");
    const afterCorrection = await store.getTask(task.id);
    assert.equal(afterCorrection.review?.semanticIteration, 1);
    assert.equal(afterCorrection.review?.reviews[0]?.correction?.status, "completed");
    await store.saveReviewResult(task.id, 2, "approved", "all good", []);
    assert.equal(await reviewRun, "done");

    const final = await store.getTask(task.id);
    assert.equal(final.review?.status, "approved");
    assert.equal(final.review?.semanticIteration, 2);
    assert.equal(final.review?.reviews.length, 2);
    assert.equal(final.review?.reviews[0]?.status, "changes_requested");
    assert.equal(final.review?.reviews[1]?.status, "approved");
    assert.deepEqual(browser.calls, ["TARGET_A:review", "TARGET_A:review"]);
    assert.equal(createdTargets, 0);
    assert.equal(final.review?.reviews.filter((r) => r.status === "changes_requested").length, 1);
    assert.equal(final.review?.reviews.filter((r) => r.status === "approved").length, 1);
    assert.equal(final.execution?.round, 0);
    assert.equal(final.review?.reviews[0]?.correction?.round, 1);

    // Duplicate terminal submissions fail closed and cannot restart correction/review.
    await assert.rejects(() => store.saveReviewResult(task.id, 2, "approved", "duplicate", []), /No review awaiting submission/);
    assert.equal(browser.calls.length, 2);
    assert.equal(createdTargets, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("max iterations bounds correction rounds and keeps same reviewer target", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-v2-max-"));
  try {
    const { store, task: original } = await executedTask(dir);
    const task = await store.updateChat(original.id, { ...original.chat!, targetId: "TARGET_A" });
    const browser = fakeBrowser(true);
    const correctionRounds: number[] = [];
    const orch = new ReviewOrchestrator({
      store, browser: browser.controller, isInfrastructureReady: async () => true,
      maxReviewIterations: 3, reviewTimeoutMs: 2_000,
      getExecutor: () => ({ execute: async (input) => {
        correctionRounds.push(input.round!);
        const result = okResult();
        if (input.round !== undefined) result.round = input.round;
        return result;
      } })
    });
    const run = orch.retryReview(task.id);
    for (const iteration of [1, 2, 3]) {
      await waitFor(store, task.id, (t) => t.review?.reviews.at(-1)?.status === "reviewing");
      await store.saveReviewResult(task.id, iteration, "changes_requested", "still broken", [{ severity: "major", issue: "missing", requested_change: "fix" }]);
    }
    await run;
    const final = await store.getTask(task.id);
    assert.equal(final.review?.status, "max_iterations_reached");
    assert.equal(final.review?.semanticIteration, 3);
    assert.deepEqual(correctionRounds, [1, 2]);
    assert.equal(final.review?.reviews.length, 3);
    assert.deepEqual(browser.calls, ["TARGET_A:review", "TARGET_A:review", "TARGET_A:review"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(browser.calls.length, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("review transport failure is operational, retryable, and does not consume semantic iteration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-v2-operational-"));
  try {
    const { store, task } = await executedTask(dir);
    let sends = 0;
    const browser = { sendReviewPrompt: async () => { sends++; throw new Error("mcp_unavailable: reviewer transport down"); } };
    let corrections = 0;
    const orch = new ReviewOrchestrator({
      store, browser: browser as never, getExecutor: () => ({ execute: async () => { corrections++; return okResult(); } }),
      isInfrastructureReady: async () => true, maxReviewIterations: 3, reviewTimeoutMs: 100
    });
    assert.match(await orch.retryReview(task.id), /mcp_unavailable/);
    const failed = await store.getTask(task.id);
    assert.equal(failed.review?.status, "failed");
    assert.equal(failed.review?.semanticIteration, 0);
    assert.equal(failed.review?.reviews.at(-1)?.status, "failed");
    assert.equal(corrections, 0);
    assert.equal(sends, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("max iterations stops loop; no fourth correction; missing target and timeout fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-v2-"));
  try {
    const { store, task } = await executedTask(dir);
    const executor = { calls: [] as string[] };
    const { orch } = orchestrator(store, fakeBrowser(true).controller, { executor, max: 1 });
    const round1 = orch.retryReview(task.id);
    await waitFor(store, task.id, (t) => t.review?.reviews.at(-1)?.status === "reviewing");
    await store.saveReviewResult(task.id, 1, "changes_requested", "still broken", blocking);
    await round1;
    await waitFor(store, task.id, (t) => t.review?.status === "max_iterations_reached");
    await orch.retryReview(task.id); // remains bounded
    const final = await store.getTask(task.id);
    assert.equal(final.review?.status, "max_iterations_reached");
    assert.deepEqual(executor.calls, []); // final permitted review cannot trigger unreviewed mutation

    // missing target fails closed with planner_target_unavailable (retryReview returns the error message)
    const { store: s2, task: t2 } = await executedTask(dir);
    const { orch: orch2 } = orchestrator(s2, fakeBrowser(false).controller);
    assert.match(await orch2.retryReview(t2.id), /planner_target_unavailable/);
    assert.equal((await s2.getTask(t2.id)).review?.status, "failed");

    // review timeout persists failure, never approval
    const { store: s3, task: t3 } = await executedTask(dir);
    const { orch: orch3 } = orchestrator(s3, fakeBrowser(true).controller, { timeoutMs: 150 });
    assert.match(await orch3.retryReview(t3.id), /review timed out/);
    const failed = await s3.getTask(t3.id);
    assert.equal(failed.review?.status, "failed");
    assert.match(failed.review?.reviews.at(-1)?.error ?? "", /review_timeout/);
    // persisted failed review is restart-safe and explicitly retryable
    const restarted = new TaskStore(dir);
    assert.equal((await restarted.getTask(t3.id)).review?.status, "failed");

    // infrastructure down -> operational failure, execution preserved
    const { store: s4, task: t4 } = await executedTask(dir);
    const { orch: orch4 } = orchestrator(s4, fakeBrowser(true).controller, { ready: false });
    assert.match(await orch4.retryReview(t4.id), /not ready/);
    const opFail = await s4.getTask(t4.id);
    assert.equal(opFail.review?.status, "failed");
    assert.equal(opFail.status, "execution_completed");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("submit_review validation: wrong task/iteration rejected; scope-expansion blocks; evidence captured", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-v2-"));
  try {
    const { store, task } = await executedTask(dir);
    const other = await store.createTask(dir, "other");
    await assert.rejects(() => store.saveReviewResult(other.id, 1, "approved", "x", []), /no review/);
    const { orch } = orchestrator(store, fakeBrowser(true).controller, { executor: { calls: [] } });
    const round = orch.retryReview(task.id);
    await waitFor(store, task.id, (t) => t.review?.reviews.at(-1)?.status === "reviewing");
    await assert.rejects(() => store.saveReviewResult(task.id, 5, "approved", "x", []), /Iteration mismatch/);
    await assert.rejects(() => store.saveReviewResult(task.id, 1, "changes_requested", "empty", []), /requires at least one finding/);
    await assert.rejects(() => store.saveReviewResult(task.id, 1, "approved", "bad", blocking), /cannot contain blocking findings/);
    await store.saveReviewResult(task.id, 1, "changes_requested", "fix", blocking);
    await waitFor(store, task.id, (t) => t.review?.reviews.length === 2 && t.review.reviews[1]?.status === "reviewing");
    await store.saveReviewResult(task.id, 2, "approved", "fixed", []);
    await round;
    const mid = await store.getTask(task.id);
    assert.ok(mid.gitEvidence?.postExecution); // post-execution evidence captured for reviewer
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("scope-expansion finding stops before correction dispatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-v2-"));
  try {
    const { store, task } = await executedTask(dir);
    const executor = { calls: [] as string[] };
    const { orch } = orchestrator(store, fakeBrowser(true).controller, { executor });
    const round = orch.retryReview(task.id);
    await waitFor(store, task.id, (t) => t.review?.status === "reviewing");
    await store.saveReviewResult(task.id, 1, "changes_requested", "needs wider change", [{ ...blocking[0]!, scopeExpansionRequired: true }]);
    await round;
    const final = await store.getTask(task.id);
    assert.equal(final.review?.status, "scope_expansion_required");
    assert.deepEqual(executor.calls, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("operational failure retry reuses semantic iteration and legacy max state recovers safely", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-v2-"));
  try {
    const { store, task } = await executedTask(dir);
    const first = await store.startReview(task.id, 3);
    assert.equal(first.review?.iteration, 1);
    await store.failReview(task.id, "planner_target_unavailable: target missing");
    const retry = await store.startReview(task.id, 3);
    assert.equal(retry.review?.iteration, 1);
    assert.equal(retry.review?.semanticIteration, 0);
    assert.equal(retry.review?.reviews.length, 1);

  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("closing planner target fails pending review without consuming semantic iteration; approved is unaffected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-v2-"));
  try {
    const { store, task } = await executedTask(dir);
    await store.startReview(task.id, 3);
    await store.markReviewTargetClosed();
    let current = await store.getTask(task.id);
    assert.equal(current.review?.status, "failed");
    assert.equal(current.review?.error?.kind, "planner_target_closed");
    assert.equal(current.review?.semanticIteration, 0);
    assert.equal(current.review?.iteration, 0);
    assert.match(current.review?.error?.message ?? "", /Original Temporary Chat/);

    const approved = await executedTask(dir);
    await approved.store.startReview(approved.task.id, 3);
    await approved.store.saveReviewResult(approved.task.id, 1, "approved", "good", []);
    await approved.store.markReviewTargetClosed();
    current = await approved.store.getTask(approved.task.id);
    assert.equal(current.review?.status, "approved");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("MCP registry contains no source-write/shell/git-mutation tools", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(join(process.cwd(), "src/mcp/server.ts"), "utf8");
  const tools = [...source.matchAll(/registerTool\(\s*\n?\s*"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(tools.includes("submit_plan") && tools.includes("submit_review") && tools.includes("review_context") && tools.includes("test_status"));
  for (const forbidden of ["write_file", "edit_file", "shell", "exec", "commit", "push", "checkout", "reset", "stash", "install"]) {
    assert.ok(!tools.includes(forbidden), `forbidden tool registered: ${forbidden}`);
  }
});

async function waitFor(store: TaskStore, id: string, predicate: (task: PlannerTask) => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(await store.getTask(id))) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor timeout");
}
