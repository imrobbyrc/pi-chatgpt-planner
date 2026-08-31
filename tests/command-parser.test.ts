import test from "node:test";
import assert from "node:assert/strict";
import { parseAdjustment, parseFreeForm } from "../src/command-parser.js";

const request = "Add one small documentation note explaining that planner tasks use the active Pi planning method.";

test("free-form parser preserves long quoted and unquoted requests", () => {
  assert.equal(parseFreeForm(`"${request}"`), request);
  assert.equal(parseFreeForm(request), request);
  assert.equal(parseFreeForm("Add punctuation: use, with, from; then verify."), "Add punctuation: use, with, from; then verify.");
});

test("adjustment parser preserves quoted feedback and punctuation", () => {
  const feedback = "use A instead of B and keep the rest unchanged; verify it.";
  assert.deepEqual(parseAdjustment(`"${feedback}"`), { feedback });
  assert.deepEqual(parseAdjustment(feedback), { feedback });
});

test("adjustment parser accepts short and full explicit IDs", () => {
  const feedback = "use A instead of B";
  assert.deepEqual(parseAdjustment(`87c9c4bb "${feedback}"`), { id: "87c9c4bb", feedback });
  assert.deepEqual(parseAdjustment(`2e87b64a-806f-4030-86a2-8c71200a2acf ${feedback}`), { id: "2e87b64a-806f-4030-86a2-8c71200a2acf", feedback });
});

test("quoted UUID-like prose is never reinterpreted as an ID", () => {
  const feedback = "87c9c4bb is mentioned as part of this prose";
  assert.deepEqual(parseAdjustment(`"${feedback}"`), { feedback });
});
