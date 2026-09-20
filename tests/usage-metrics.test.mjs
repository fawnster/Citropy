import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyUsage } from "../shared/protocol.ts";
import {
  cacheHitRate,
  estimateConversationTokens,
  mergeUsage,
  parseAcpUsage,
  tokensPerSecond,
  uncachedInput,
} from "../shared/usage-metrics.ts";

test("ACP usage parses prompt totals, window updates, and Cursor aliases", () => {
  assert.deepEqual(parseAcpUsage({
    used: 12000,
    size: 200000,
    cost: { amount: 0.02, currency: "USD" },
    _meta: { cachedReadTokens: 4000, outputTokens: 300 },
  }), {
    contextTokens: 12000,
    contextMax: 200000,
    costUsd: 0.02,
    cacheRead: 4000,
    output: 300,
  });
  assert.deepEqual(parseAcpUsage({
    stopReason: "end_turn",
    usage: {
      totalTokens: 12700,
      inputTokens: 2500,
      outputTokens: 800,
      cachedReadTokens: 9000,
      cachedWriteTokens: 400,
    },
  }), {
    input: 2500,
    output: 800,
    cacheRead: 9000,
    cacheWrite: 400,
  });
  assert.deepEqual(parseAcpUsage({
    tokenDetails: { usedTokens: 64000, maxTokens: 200000, breakdown: { cacheReadTokens: 1000 } },
  }), {
    contextTokens: 64000,
    contextMax: 200000,
    cacheRead: 1000,
  });
});

test("cache hit rate treats Codex input as inclusive and Claude input as fresh", () => {
  assert.equal(uncachedInput("claude", { input: 200, cacheRead: 1000, cacheWrite: 100 }), 200);
  assert.equal(uncachedInput("codex", { input: 1300, cacheRead: 1000, cacheWrite: 100 }), 200);
  assert.equal(cacheHitRate("claude", { input: 200, cacheRead: 800, cacheWrite: 0 }), 0.8);
  assert.equal(cacheHitRate("codex", { input: 1000, cacheRead: 800, cacheWrite: 0 }), 0.8);
  assert.equal(cacheHitRate("cursor", { input: 0, cacheRead: 0, cacheWrite: 0 }), 0);
});

test("conversation estimates and merge fill Cursor context without replacing a real window", () => {
  const messages = [
    { id: "u", role: "user", ts: 1, parts: [{ id: "u1", kind: "text", text: "abcd".repeat(25) }] },
    { id: "a", role: "assistant", ts: 2, parts: [{ id: "a1", kind: "text", text: "efgh".repeat(25) }] },
  ];
  assert.equal(estimateConversationTokens(messages), 50);
  const estimated = mergeUsage({
    previous: emptyUsage(),
    provider: "cursor",
    messages,
    contextMax: 200000,
    estimateContext: true,
  });
  assert.equal(estimated.contextTokens, 50);
  assert.equal(estimated.contextMax, 200000);
  assert.equal(estimated.contextEstimated, true);
  const kept = mergeUsage({
    previous: { ...emptyUsage(), contextTokens: 12000, contextMax: 200000 },
    incoming: { output: 40 },
    provider: "cursor",
    messages,
    estimateContext: true,
  });
  assert.equal(kept.contextTokens, 12000);
  assert.equal(kept.contextEstimated, undefined);
  const speed = mergeUsage({
    previous: emptyUsage(),
    incoming: { output: 80 },
    provider: "claude",
    runStartedAt: 1_000,
    outputAtStart: 0,
    now: 3_000,
  });
  assert.equal(speed.tokensPerSecond, 40);
  assert.equal(tokensPerSecond(80, 2000), 40);
  assert.equal(tokensPerSecond(80, 100), 0);
});
