import assert from "node:assert/strict";
import { test } from "node:test";
import { channelOf, appIconName } from "../desktop/channel.mjs";

test("channel detection maps rolling builds to lime and everything else to stable", () => {
  assert.equal(channelOf("0.3.0"), "stable");
  assert.equal(channelOf("0.2.1-lime.3"), "lime");
  assert.equal(channelOf("0.2.1-lemon.3"), "lime");
  assert.equal(channelOf("0.2.1-lime.3.1"), "lime");
  assert.equal(channelOf("0.2.1-beta.1"), "stable");
});

test("the app icon follows development first, then the channel", () => {
  assert.equal(appIconName({ development: true, channel: "lime" }), "citropy-dev");
  assert.equal(appIconName({ development: true, channel: "stable" }), "citropy-dev");
  assert.equal(appIconName({ development: false, channel: "lime" }), "citropy-lime");
  assert.equal(appIconName({ development: false, channel: "stable" }), "citropy");
});
