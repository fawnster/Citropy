import assert from "node:assert/strict";
import { test } from "node:test";
import { channelOf } from "../desktop/channel.mjs";

test("channel detection maps rolling builds to lime and everything else to stable", () => {
  assert.equal(channelOf("0.3.0"), "stable");
  assert.equal(channelOf("0.2.1-lime.3"), "lime");
  assert.equal(channelOf("0.2.1-lemon.3"), "lime");
  assert.equal(channelOf("0.2.1-lime.3.1"), "lime");
  assert.equal(channelOf("0.2.1-beta.1"), "stable");
});
