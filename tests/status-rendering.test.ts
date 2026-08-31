import test from "node:test";
import assert from "node:assert/strict";
import { approvalLabel, executionLabel, planningLabel, reviewLabel } from "../extensions/chatgpt-planner/index.js";
import type { PlannerTask, TaskStatus } from "../src/types.js";

function task(status: TaskStatus): PlannerTask {
  return { id: "123e4567-e89b-12d3-a456-426614174000", createdAt: "", updatedAt: "", workspaceRoot: "/tmp", request: "x", status, plan: { summary: "x", planMarkdown: "x", filesToInspect: [], acceptanceCriteria: [], tests: [], risks: [], openQuestions: [], submittedAt: "" } };
}

test("status sections map independently from lifecycle status", () => {
  const cases: Array<[TaskStatus, string, string, string]> = [
    ["awaiting_approval", "complete", "awaiting approval", "not started"],
    ["rejected", "complete", "rejected", "not started"],
    ["executing", "complete", "approved", "executing"],
    ["execution_completed", "complete", "approved", "completed"],
    ["execution_failed", "complete", "approved", "failed"]
  ];
  for (const [status, planning, approval, execution] of cases) {
    const current = task(status);
    assert.equal(planningLabel(current), planning);
    assert.equal(approvalLabel(current), approval);
    assert.equal(executionLabel(current), execution);
  }
});

test("review status renders independently from execution status", () => {
  const current = task("execution_completed");
  current.review = { status: "changes_requested", iteration: 2, reviews: [] };
  assert.equal(executionLabel(current), "completed");
  assert.equal(reviewLabel(current), "changes requested (iterations: 2)");
  current.review.status = "max_iterations_reached";
  assert.equal(reviewLabel(current), "max iterations reached (iterations: 2)");
});
