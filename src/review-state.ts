import type { ReviewState } from "./types.js";

export interface NormalizedReviewState {
  review: ReviewState;
  changed: boolean;
  actualSemanticReviews: number;
  actualChangesRequested: number;
}

/** Normalize persisted review state using semantic verdicts, never attempt counters. */
export function normalizeReviewState(review: ReviewState | undefined, maxIterations: number): NormalizedReviewState {
  const current = review ?? { status: "not_started" as const, iteration: 0, reviews: [] };
  const semantic = current.reviews.filter((record) => record.status === "approved" || record.status === "changes_requested");
  const actualChangesRequested = semantic.filter((record) => record.status === "changes_requested").length;
  const actualSemanticReviews = semantic.length;
  const semanticIteration = actualSemanticReviews;
  let status = current.status;
  let error = current.error;

  if (semantic.some((record) => record.status === "approved")) {
    status = "approved";
  } else if (actualChangesRequested >= maxIterations && maxIterations > 0) {
    status = "max_iterations_reached";
  } else if (current.status === "max_iterations_reached") {
    status = "failed";
    error = { kind: "legacy_operational_failure_recovered", message: "Recovered legacy max_iterations_reached with no semantic review verdicts at configured limit.", occurredAt: new Date().toISOString() };
  }

  const { error: _oldError, ...withoutError } = current;
  const next: ReviewState = { ...withoutError, status, iteration: semanticIteration, semanticIteration, ...(error ? { error } : {}), reviews: current.reviews };
  const changed = JSON.stringify(next) !== JSON.stringify(current);
  return { review: next, changed, actualSemanticReviews, actualChangesRequested };
}
