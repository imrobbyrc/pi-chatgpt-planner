import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../src/task-store.js";
import type { ExecutionResult } from "../src/types.js";

const plan = { summary: "Do X", planMarkdown: "1. Do X", filesToInspect: [], acceptanceCriteria: [], tests: [], risks: [], openQuestions: [] };

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "pi-v1-"));
  const store = new TaskStore(dir);
  const task = await store.createTask(dir, "Do X");
  await store.submitPlan(task.id, plan);
  return { dir, store, task };
}

function result(status: "completed" | "failed"): ExecutionResult {
  return { status, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), summary: status, filesChanged: [], validations: ["npm test"], deviations: [], remainingIssues: [], ...(status === "failed" ? { error: "test failed" } : {}) };
}

test("V1 approval claim is explicit, idempotent, and persisted", async () => {
  const { dir, store, task } = await setup();
  try {
    assert.equal((await store.getTask(task.id)).status, "awaiting_approval");
    await assert.rejects(() => store.transition(task.id, "executing"), /Invalid task transition/);
    await store.transition(task.id, "approved");
    const claim = await store.claimExecution(task.id);
    assert.equal(claim?.status, "executing");
    assert.equal(await store.claimExecution(task.id), undefined);
    await store.saveExecution(task.id, result("completed"));
    assert.equal((await new TaskStore(dir).getTask(task.id)).status, "execution_completed");
    assert.equal(await store.claimExecution(task.id), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("rejection cannot execute and failure details persist", async () => {
  const { dir, store, task } = await setup();
  try {
    await store.transition(task.id, "rejected");
    assert.equal(await store.claimExecution(task.id), undefined);
    assert.equal((await store.getTask(task.id)).status, "rejected");

    const second = await store.createTask(dir, "Do Y");
    await store.submitPlan(second.id, plan);
    await store.transition(second.id, "approved");
    assert.equal((await store.claimExecution(second.id))?.status, "executing");
    const failed = await store.saveExecution(second.id, result("failed"));
    assert.equal(failed.status, "execution_failed");
    assert.equal(failed.execution?.error, "test failed");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
