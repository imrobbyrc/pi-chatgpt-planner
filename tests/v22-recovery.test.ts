import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { TaskStore } from "../src/task-store.js";

test("restart recovery marks executing workers ambiguous without replay", async () => {
  const dir = await mkdtemp(join("/tmp", "pi-v22-recovery-"));
  try {
    const store = new TaskStore(dir);
    const task = await store.createTask("/tmp", "x", [], "herdr");
    await store.submitPlan(task.id, { summary: "x", planMarkdown: "x", filesToInspect: [], acceptanceCriteria: [], tests: [], risks: [], openQuestions: [], execution: { mode: "herdr", workerModel: "luna-max", workers: [{ id: "one", objective: "x", owns: ["one/**"], dependsOn: [] }] } });
    await store.transition(task.id, "approved");
    await store.claimExecution(task.id);
    const recovered = await new TaskStore(dir).recoverInterruptedExecutions();
    assert.equal(recovered[0]?.status, "execution_failed");
    assert.match(recovered[0]?.execution?.error ?? "", /ambiguous/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
