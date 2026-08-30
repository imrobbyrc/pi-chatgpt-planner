import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../src/task-store.js";

test("TaskStore creates and receives a plan", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-planner-"));
  try {
    const store = new TaskStore(dir);
    const task = await store.createTask("/tmp/workspace", "Implement feature X");
    assert.equal(task.status, "planning");

    const withChat = await store.updateChat(task.id, {
      targetId: "planner-target",
      conversationUrl: "https://chatgpt.com/c/12345678-1234-1234-1234-123456789012",
      conversationId: "12345678-1234-1234-1234-123456789012",
      temporary: true,
      personalized: true,
      reasoning: "high"
    });
    assert.equal(withChat.chat?.temporary, true);
    assert.equal(withChat.chat?.reasoning, "high");

    const completed = await store.submitPlan(task.id, {
      summary: "Feature X",
      planMarkdown: "1. Do X",
      filesToInspect: ["src/x.ts"],
      acceptanceCriteria: ["X works"],
      tests: ["test X"],
      risks: [],
      openQuestions: []
    });

    assert.equal(completed.status, "awaiting_approval");
    assert.equal(completed.plan?.summary, "Feature X");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
