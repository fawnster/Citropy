import assert from "node:assert/strict";
import { test } from "node:test";

async function fixture(t) {
  const previous = globalThis.Worker;
  const workers = [];
  globalThis.Worker = class {
    messages = [];
    terminated = false;
    constructor() { workers.push(this); }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
    reply(id, result) { this.onmessage({ data: { id, result } }); }
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => { t.mock.timers.tick(90_000); globalThis.Worker = previous; });
  const highlighting = await import(`../web/src/lib/highlight.ts?test=${encodeURIComponent(t.name)}`);
  return { ...highlighting, workers };
}

test("cancelled highlighting settles immediately and late results cannot replace another request", async (t) => {
  const { highlightTokens, workers } = await fixture(t);
  const controller = new AbortController();
  const stale = highlightTokens("old file", "ts", "dark", controller.signal);
  const current = highlightTokens("new file", "ts", "dark");
  assert.equal(workers.length, 1);
  const worker = workers[0];
  const [oldRequest, currentRequest] = worker.messages;
  controller.abort();
  assert.equal(await stale, null);
  assert.deepEqual(worker.messages.at(-1), { cancel: oldRequest.id });
  worker.reply(oldRequest.id, ["Wrong file"]);
  worker.reply(currentRequest.id, ["Correct file"]);
  assert.deepEqual(await current, ["Correct file"]);
  const cancelled = new AbortController();
  cancelled.abort();
  const count = worker.messages.length;
  assert.equal(await highlightTokens("never sent", "ts", "dark", cancelled.signal), null);
  assert.equal(worker.messages.length, count);
});

test("worker failures return escaped text and later requests start a fresh worker", async (t) => {
  const { highlight, highlightTokens, workers } = await fixture(t);
  const failed = highlight("<script>alert(1)</script>", "html", "dark");
  workers[0].onerror(new Error("Worker stopped"));
  assert.equal(await failed, '<pre class="raw"><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>');
  assert.equal(workers[0].terminated, true);
  const current = highlightTokens("const current = true;", "ts", "dark");
  assert.equal(workers.length, 2);
  workers[1].reply(workers[1].messages[0].id, ["colored text"]);
  assert.deepEqual(await current, ["colored text"]);
  workers[1].postMessage = () => { throw new Error("Cannot post to the worker"); };
  assert.equal(await highlightTokens("unavailable", "ts", "dark"), null);
  assert.equal(workers[1].terminated, true);
});

test("idle highlighting releases its worker and active work resets the idle deadline", async (t) => {
  const { highlightTokens, workers } = await fixture(t);
  const first = highlightTokens("first", "ts", "dark");
  workers[0].reply(workers[0].messages[0].id, ["first"]);
  await first;
  t.mock.timers.tick(59_999);
  assert.equal(workers[0].terminated, false);
  const next = highlightTokens("second", "ts", "dark");
  t.mock.timers.tick(1);
  assert.equal(workers[0].terminated, false);
  workers[0].reply(workers[0].messages.at(-1).id, ["second"]);
  await next;
  t.mock.timers.tick(60_000);
  assert.equal(workers[0].terminated, true);
  const restarted = highlightTokens("third", "ts", "dark");
  assert.equal(workers.length, 2);
  workers[1].reply(workers[1].messages[0].id, ["third"]);
  assert.deepEqual(await restarted, ["third"]);
});

test("unresponsive workers time out pending work instead of retaining it indefinitely", async (t) => {
  const { highlightTokens, workers } = await fixture(t);
  const first = highlightTokens("first", "ts", "dark");
  const second = highlightTokens("second", "ts", "dark");
  t.mock.timers.tick(30_000);
  assert.deepEqual(await Promise.all([first, second]), [null, null]);
  assert.equal(workers[0].terminated, true);
});
