import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../src/task-store.js";
import { TaskResolver } from "../src/task-resolver.js";

const chat = { targetId: "planner-target", temporary: true, personalized: true, reasoning: "high" as const };
const plan = { summary: "Feature", planMarkdown: "do it", filesToInspect: [], acceptanceCriteria: [], tests: [], risks: [], openQuestions: [] };

async function waiting(store: TaskStore, request = "Feature") {
  const task = await store.createTask("/tmp", request);
  await store.updateChat(task.id, chat);
  return store.submitPlan(task.id, plan);
}

test("resolver uses current task, exact IDs, unique prefixes, and rejects ambiguity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-resolver-"));
  try {
    const store = new TaskStore(dir); const first = await waiting(store); const second = await waiting(store, "Other");
    const resolver = new TaskResolver(store); resolver.setCurrent(first);
    assert.equal((await resolver.resolve("approve")).id, first.id);
    assert.equal((await resolver.resolve("approve", second.id.slice(0, 8))).id, second.id);
    const ambiguous = new TaskResolver({ listTasks: async () => [
      { ...first, id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
      { ...second, id: "aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }
    ] } as unknown as TaskStore);
    await assert.rejects(() => ambiguous.resolve("approve", "aaaa"), /Ambiguous/);
    await assert.rejects(() => resolver.resolve("approve", "deadbeef"), /Unknown/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("plan revisions preserve target, full plan, feedback, and stale base protection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-revision-"));
  try {
    const store = new TaskStore(dir); const task = await waiting(store);
    const revised = await store.submitPlanRevision(task.id, 1, { ...plan, summary: "Revised" }, "use Redis");
    assert.equal(revised.planRevisions?.currentRevision, 2);
    assert.equal(revised.planRevisions?.revisions[1]?.feedback, "use Redis");
    assert.equal(revised.planRevisions?.revisions[1]?.targetId, "planner-target");
    assert.equal(revised.plan?.summary, "Revised");
    await assert.rejects(() => store.submitPlanRevision(task.id, 1, plan, "stale"), /Stale/);
    await store.transition(task.id, "approved"); await store.claimExecution(task.id);
    await assert.rejects(() => store.submitPlanRevision(task.id, 2, plan, "late"), /only allowed before approval/);
    const locked = await store.getTask(task.id);
    assert.equal(locked.planRevisions?.approvedRevision, 2);
    assert.equal(locked.chat?.targetId, "planner-target");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
