import assert from "node:assert/strict";
import { test } from "node:test";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Claude usage separates the active context from cumulative processing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-provider-usage-"));
  const previousData = process.env.CITROPY_DATA_DIR;
  process.env.CITROPY_DATA_DIR = directory;
  const originalSpawn = childProcess.spawn;
  const children = [];
  const sessions = [];
  childProcess.spawn = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit("close", 0)); return true; };
    children.push(child);
    return child;
  };
  syncBuiltinESMExports();
  t.after(async () => {
    sessions.forEach((session) => session.dispose());
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    if (previousData === undefined) delete process.env.CITROPY_DATA_DIR;
    else process.env.CITROPY_DATA_DIR = previousData;
    await rm(directory, { recursive: true, force: true });
  });
  const { claudeProvider } = await import("../server/providers/claude.ts");
  const fixture = (usage) => {
    const events = [];
    const session = claudeProvider.start({ threadId: "usage", cwd: "/tmp", model: "main-model", contextMax: 1000000, permissionMode: "manual", usage, emit: (event) => events.push(event) });
    sessions.push(session);
    const child = children.at(-1);
    return { session, events, notify: (event) => child.stdout.write(JSON.stringify(event) + "\n"), latest: () => events.findLast((event) => event.type === "usage")?.usage };
  };
  const modelUsage = (input, output, read, write, contextWindow = 1000000) => ({ inputTokens: input, outputTokens: output, cacheReadInputTokens: read, cacheCreationInputTokens: write, contextWindow });
  const assistant = (id, usage, parent) => ({ type: "assistant", parent_tool_use_id: parent, message: { id, model: parent ? "helper" : "main-model", usage } });

  await t.test("zero-filled error messages and whole-turn totals cannot replace a valid context reading", () => {
    const f = fixture();
    const usage = { input_tokens: 2, cache_read_input_tokens: 598546, cache_creation_input_tokens: 232, output_tokens: 1 };
    f.notify(assistant("step", usage));
    f.notify(assistant("step", usage));
    assert.equal(f.latest().contextTokens, 598781);
    assert.equal(f.latest().cacheRead, 598546);
    for (const id of ["step", "error-one", "error-two"]) f.notify(assistant(id, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }));
    assert.equal(f.latest().contextTokens, 598781);
    assert.equal(f.latest().cacheRead, 598546);
    f.notify({ type: "result", usage: { input_tokens: 2000, cache_read_input_tokens: 44000000, output_tokens: 220000 } });
    assert.equal(f.latest().contextTokens, 598781);
  });

  await t.test("model totals correct placeholder output once and preserve the main model's window", () => {
    const f = fixture({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40, costUsd: 2, contextTokens: 200, contextMax: 1000000, turns: 1 });
    f.notify(assistant("main-step", { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 900 }));
    f.notify(assistant("child-step", { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 200 }, "agent-tool"));
    const result = { type: "result", total_cost_usd: 4, modelUsage: { helper: modelUsage(50, 400, 200, 0, 200000), "main-model": modelUsage(100, 2000, 900, 0) } };
    f.notify(result);
    assert.deepEqual(f.latest(), { input: 160, output: 2420, cacheRead: 1130, cacheWrite: 40, costUsd: 6, contextTokens: 1001, contextMax: 1000000 });
    f.notify(result);
    assert.equal(f.latest().output, 2420);
    f.notify(assistant("next-step", { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 3000 }));
    f.notify({ ...result, modelUsage: { helper: result.modelUsage.helper, "main-model": modelUsage(220, 2200, 3900, 0) } });
    assert.equal(f.latest().output, 2620);
    assert.equal(f.latest().cacheRead, 4130);
    const resumed = fixture({ ...f.latest(), turns: 2 });
    resumed.notify({ type: "result", total_cost_usd: 1, modelUsage: { "main-model": modelUsage(20, 100, 3000, 0) } });
    assert.equal(resumed.latest().output, 2720);
    assert.equal(resumed.latest().costUsd, 7);
  });

  await t.test("a result without per-request usage leaves the window unknown even with millions processed", () => {
    const f = fixture();
    f.notify({ type: "result", usage: { input_tokens: 2000, output_tokens: 200000, cache_read_input_tokens: 44000000 }, modelUsage: { "main-model": modelUsage(2000, 200000, 44000000, 0) } });
    assert.equal(f.latest().contextTokens, 0);
    assert.equal(f.latest().cacheRead, 44000000);
    const legacy = fixture({ ...f.latest(), contextTokens: 44202000 });
    legacy.notify({ type: "result", usage: { input_tokens: 2000, cache_read_input_tokens: 44000000 } });
    assert.equal(legacy.latest().contextTokens, 0);
  });

  await t.test("iteration reports use the latest main request instead of accumulated or advisor tokens", () => {
    const f = fixture();
    const usage = { input_tokens: 1000000, cache_read_input_tokens: 43000000, output_tokens: 100000, iterations: [
      { type: "message", input_tokens: 100, cache_read_input_tokens: 5000, output_tokens: 200 },
      { type: "message", input_tokens: 150, cache_read_input_tokens: 8000, output_tokens: 300 },
      { type: "advisor", input_tokens: 1000, output_tokens: 4000 },
    ] };
    f.notify({ type: "result", usage });
    assert.equal(f.latest().contextTokens, 8450);
    f.notify(assistant("iteration-step", usage));
    assert.equal(f.latest().contextTokens, 8450);
  });

  await t.test("compaction invalidates an unreported reading and does not resurrect pre-compaction totals", async () => {
    const f = fixture();
    f.notify(assistant("before", { input_tokens: 900000, output_tokens: 10 }));
    await f.session.compact();
    f.notify({ type: "system", subtype: "compact_boundary", compact_metadata: {} });
    f.notify({ type: "result", usage: { input_tokens: 5000000, output_tokens: 2000 } });
    assert.equal(f.latest().contextTokens, 0);
    assert.equal(f.events.findLast((event) => event.type === "compacted").contextTokens, 0);
    f.notify(assistant("after", { input_tokens: 40000, output_tokens: 20 }));
    assert.equal(f.latest().contextTokens, 40020);
    f.notify({ type: "system", subtype: "compact_boundary", compact_metadata: { post_tokens: 12000 } });
    f.notify({ type: "result", usage: { input_tokens: 5000000, output_tokens: 2000 } });
    assert.equal(f.latest().contextTokens, 12000);
  });
});
