import test from "node:test";
import assert from "node:assert/strict";
import { normalizeReviewState } from "../src/review-state.js";

test("normalizes legacy max state with only operational failures", () => {
  const result = normalizeReviewState({
    status: "max_iterations_reached", iteration: 3,
    reviews: [1, 2, 3].map((iteration) => ({ iteration, startedAt: "", completedAt: "", status: "failed" as const, findings: [], error: "planner_target_unavailable: original conversation identity was never confirmed" }))
  }, 3);
  assert.equal(result.actualSemanticReviews, 0);
  assert.equal(result.actualChangesRequested, 0);
  assert.equal(result.review.status, "failed");
  assert.equal(result.review.semanticIteration, 0);
  assert.equal(result.review.error?.kind, "legacy_operational_failure_recovered");
  assert.equal(result.review.reviews.length, 3);
  assert.equal(result.review.reviews.at(-1)?.status, "failed");
});

test("max is terminal only after semantic CHANGES_REQUESTED count reaches limit", () => {
  const record = (iteration: number, status: "changes_requested" | "approved") => ({ iteration, startedAt: "", completedAt: "", status, findings: [{ severity: "major" as const, issue: "x" }] });
  assert.equal(normalizeReviewState({ status: "max_iterations_reached", iteration: 3, reviews: [record(1, "changes_requested"), record(2, "changes_requested"), record(3, "changes_requested")] }, 3).review.status, "max_iterations_reached");
  assert.equal(normalizeReviewState({ status: "max_iterations_reached", iteration: 99, reviews: [record(1, "changes_requested")] }, 3).review.status, "failed");
  assert.equal(normalizeReviewState({ status: "max_iterations_reached", iteration: 99, reviews: [record(1, "approved")] }, 3).review.status, "approved");
});

test("many operational failures still leave semantic iteration at zero", () => {
  const review = { status: "failed" as const, iteration: 100, reviews: Array.from({ length: 100 }, (_, i) => ({ iteration: i + 1, startedAt: "", status: "failed" as const, findings: [] })) };
  const result = normalizeReviewState(review, 3);
  assert.equal(result.actualSemanticReviews, 0);
  assert.equal(result.review.semanticIteration, 0);
});
