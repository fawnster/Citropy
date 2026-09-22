import assert from "node:assert/strict";
import { test } from "node:test";
import { duration } from "../web/src/lib/format.ts";

test("elapsed durations carry rounded seconds into the next minute", () => {
  assert.equal(duration(59_400), "59s");
  assert.equal(duration(59_500), "1m 0s");
  assert.equal(duration(60_000), "1m 0s");
  assert.equal(duration(2_159_499), "35m 59s");
  assert.equal(duration(2_159_500), "36m 0s");
  assert.equal(duration(2_161_000), "36m 1s");
});
