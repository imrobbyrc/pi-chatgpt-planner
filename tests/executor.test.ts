import test from "node:test";
import assert from "node:assert/strict";
import { PiMessageExecutor } from "../src/executor.js";

test("dispatch does not resolve until correlated agent end", async () => {
  let sent = "";
  const executor = new PiMessageExecutor((message) => { sent = message; });
  let settled = false;
  const promise = executor.execute({ taskId: "123e4567-e89b-12d3-a456-426614174000", request: "x", workspaceRoot: "/tmp", plan: { summary: "x", planMarkdown: "x", filesToInspect: [], acceptanceCriteria: [], tests: [], risks: [], openQuestions: [], submittedAt: new Date().toISOString() }, instructions: "x" }).then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false);
  assert.equal(executor.matchesPrompt("unrelated"), false);
  assert.equal(executor.matchesPrompt(sent), true);
  await executor.complete([{ content: "done" }]);
  await promise;
  assert.equal(settled, true);
});
