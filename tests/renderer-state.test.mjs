import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.localStorage = { getItem: () => null };
const { useApp, applyEvents } = await import("../web/src/lib/store.ts");
const { awaitResponse, resolveResponse, rejectResponses } = await import("../web/src/lib/requests.ts");
const initial = useApp.getState();
const message = (id, text = "Saved text") => ({ id, role: "assistant", ts: 1, parts: [{ id: `${id}-text`, kind: "text", text }] });

test("streaming changes only its part and preserves unrelated subscriptions", () => {
  const before = applyEvents(initial, [
    { t: "message.add", threadId: "first", message: message("first") },
    { t: "message.add", threadId: "second", message: message("second") },
  ]);
  const after = applyEvents(before, [
    { t: "part.append", threadId: "second", messageId: "second", partId: "second-text", text: " one" },
    { t: "part.append", threadId: "second", messageId: "second", partId: "second-text", text: " two" },
  ]);
  assert.equal(after.parts["second-text"].text, "Saved text one two");
  assert.equal(before.parts["second-text"].text, "Saved text");
  assert.equal(after.parts["first-text"], before.parts["first-text"]);
  for (const key of ["messages", "order", "loaded", "threads"])
    assert.equal(after[key], before[key]);
  const status = applyEvents(after, [{ t: "git.status", projectId: "workspace", status: { files: [] } }]);
  for (const key of ["messages", "parts", "order", "loaded", "reveals"])
    assert.equal(status[key], after[key]);
});

test("replacing or deleting conversations releases obsolete messages and parts", () => {
  let state = applyEvents(initial, [{ t: "message.add", threadId: "keep", message: message("keep") }]);
  for (let index = 0; index < 500; index++) {
    state = applyEvents(state, [{ t: "thread.messages", threadId: "replace", messages: [message(`revision-${index}`)] }]);
    assert.equal(Object.keys(state.messages).length, 2);
    assert.equal(Object.keys(state.parts).length, 2);
  }
  const previous = state;
  state = applyEvents(state, [{ t: "thread.remove", id: "replace" }]);
  assert.deepEqual(Object.keys(state.messages), ["keep"]);
  assert.deepEqual(Object.keys(state.parts), ["keep-text"]);
  assert.equal(Object.keys(previous.messages).length, 2);
  assert.equal(state.order.replace, undefined);
  assert.equal(state.loaded.replace, undefined);
  state = applyEvents(state, [{ t: "hello", snapshot: { projects: [], threads: [], providers: [], permissions: [], home: "" } }]);
  for (const key of ["messages", "parts", "order", "loaded", "reveals"])
    assert.deepEqual(state[key], {});
  for (let index = 0; index < 500; index++)
    state = applyEvents(state, [{ t: "part.add", threadId: "unloaded", messageId: "unloaded-message", part: { id: `orphan-${index}`, kind: "text", text: "Background update" } }]);
  assert.deepEqual(state.parts, {});
  assert.deepEqual(state.reveals, {});
});

test("requests settle on replies, timeouts and disconnects without retaining timers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const completed = awaitResponse("complete");
    resolveResponse("complete", { value: "done" });
    assert.deepEqual(await completed, { value: "done" });
    const interrupted = [awaitResponse("file"), awaitResponse("tree"), awaitResponse("git")];
    const settled = Promise.allSettled(interrupted);
    rejectResponses();
    for (const result of await settled) {
      assert.equal(result.status, "rejected");
      assert.match(result.reason.message, /interrupted/);
    }
    const timeout = assert.rejects(awaitResponse("timeout", 100), /timed out/);
    t.mock.timers.tick(100);
    await timeout;
    resolveResponse("timeout", "late reply");
    const error = assert.rejects(awaitResponse("invalid-file"), /outside workspace/);
    applyEvents(initial, [{ t: "request.error", requestId: "invalid-file", error: "outside workspace" }]);
    await error;
    t.mock.timers.tick(600_000);
  } finally {
    rejectResponses();
    t.mock.timers.reset();
  }
});

test("concurrent Markdown rendering keeps each requested theme", async () => {
  const { renderMarkdown } = await import("../web/src/lib/markdown.ts");
  const text = "```typescript\nconst value = 1;\n```";
  const [dark, light] = await Promise.all([renderMarkdown(text, "dark"), renderMarkdown(text, "light")]);
  assert.match(dark, /citropy-dark/);
  assert.match(light, /citropy-light/);
});
