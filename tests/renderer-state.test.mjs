import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { useApp, applyEvents, selectThread } = await import("../web/src/lib/store.ts");
const { awaitResponse, resolveResponse, rejectResponses } = await import("../web/src/lib/requests.ts");
const initial = useApp.getState();
const message = (id, text = "Saved text") => ({ id, role: "assistant", ts: 1, parts: [{ id: `${id}-text`, kind: "text", text }] });

test("successful Git notifications stay quiet in the matching focused view while failures and background results remain visible", () => {
  const original = globalThis.document;
  globalThis.document = { visibilityState: "visible", hasFocus: () => true };
  try {
    const state = { ...initial, activeView: "git", activeProjectId: "workspace", activeThreadId: "thread", notifications: [], toasts: [] };
    const notification = { id: "push", kind: "git", level: "success", title: "Push finished", text: "workspace", createdAt: 1, read: false, target: { view: "git", projectId: "workspace", threadId: "thread" } };
    const apply = (patch = {}, context = {}) => applyEvents({ ...state, ...context }, [{ t: "notification.add", notification: { ...notification, ...patch } }]);
    assert.equal(apply().toasts.length, 0);
    assert.equal(apply().notifications[0].read, true);
    assert.equal(apply({ level: "error" }).toasts.length, 1);
    assert.equal(apply({}, { activeView: "settings" }).toasts.length, 1);
    assert.equal(apply({}, { activeProjectId: "other" }).toasts.length, 1);
    assert.equal(apply({}, { activeThreadId: "other-worktree" }).toasts.length, 1);
    assert.equal(apply({ target: { ...notification.target, view: "chat" } }, { activeView: "chat" }).toasts.length, 0);
    globalThis.document.hasFocus = () => false;
    assert.equal(apply().toasts.length, 1);
  } finally {
    if (original) globalThis.document = original;
    else delete globalThis.document;
  }
});

test("streaming changes only its part and preserves unrelated subscriptions", () => {
  const before = applyEvents(initial, [
    { t: "thread.messages", threadId: "first", messages: [] },
    { t: "thread.messages", threadId: "second", messages: [] },
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
  let state = applyEvents(initial, [{ t: "thread.messages", threadId: "keep", messages: [message("keep")] }]);
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

test("history cache evicts old conversations and their presentation state without touching saved data", () => {
  let state = { ...initial, activeThreadId: "active" };
  const load = (id, text) => ({ t: "thread.messages", threadId: id, messages: [message(id, text)] });
  state = applyEvents(state, [load("active"), load("old")]);
  state = { ...state, disclosures: { "old-text": { group: true } } };
  const previous = state;
  for (let index = 0; index < 50; index++) {
    state = applyEvents(state, [load(`chat-${index}`)]);
    assert.ok(Object.keys(state.loaded).length <= 5);
    assert.ok(state.loaded.active);
  }
  assert.equal(Object.keys(state.messages).length, 5);
  assert.equal(Object.keys(state.parts).length, 5);
  assert.equal(state.disclosures["old-text"], undefined);
  assert.ok(previous.parts["old-text"]);
  assert.equal(previous.disclosures["old-text"].group, true);
  const cached = state;
  state = applyEvents(state, [
    { t: "message.add", threadId: "old", message: message("ignored") },
    { t: "part.append", threadId: "old", messageId: "ignored", partId: "ignored-text", text: "more" },
  ]);
  assert.equal(state.parts, cached.parts);
  assert.equal(state.messages, cached.messages);
  state = applyEvents(state, [load("old", "The complete history comes from the server.")]);
  assert.equal(state.parts["old-text"].text, "The complete history comes from the server.");
  const content = "x".repeat(5 * 1024 * 1024);
  state = applyEvents(state, [load("large-first", content), load("large-second", content)]);
  assert.equal(state.loaded["large-first"], undefined);
  assert.ok(state.loaded["large-second"]);
  assert.ok(state.loaded.active);
  assert.ok(Object.values(state.historyBytes).reduce((sum, bytes) => sum + bytes, 0) <= 16 * 1024 * 1024);
});

test("history eviction skips a batch that leaves the cache unchanged even when it is oversized", () => {
  const load = (id) => ({ t: "thread.messages", threadId: id, messages: [message(id)] });
  let state = { ...initial, activeThreadId: "keep" };
  state = applyEvents(state, ["keep", "a", "b", "c", "d"].map(load));
  state = { ...state, historyBytes: { ...state.historyBytes, a: 24 * 1024 * 1024 } };
  const before = state;
  state = applyEvents(state, [{ t: "git.status", projectId: "workspace", status: { files: [] } }]);
  assert.equal(state.loaded.a, true);
  assert.equal(state.parts, before.parts);
  assert.equal(state.messages, before.messages);
  assert.ok(Object.values(state.historyBytes).reduce((sum, bytes) => sum + bytes, 0) > 16 * 1024 * 1024);
});

test("history eviction applies the byte limit to a handful of large conversations", () => {
  const content = "x".repeat(6 * 1024 * 1024);
  const load = (id, text) => ({ t: "thread.messages", threadId: id, messages: [message(id, text)] });
  let state = { ...initial, activeThreadId: "active" };
  state = applyEvents(state, [load("active", "Short")]);
  state = applyEvents(state, [load("big-first", content), load("big-second", content), load("big-third", content)]);
  assert.ok(Object.values(state.historyBytes).reduce((sum, bytes) => sum + bytes, 0) <= 16 * 1024 * 1024);
  assert.equal(state.loaded["big-first"], undefined);
  assert.ok(state.loaded.active);
});

test("revisiting a cached conversation retains it ahead of older entries", () => {
  const load = (id) => ({ t: "thread.messages", threadId: id, messages: [message(id)] });
  useApp.setState(applyEvents(initial, ["a", "b", "c", "d", "e"].map(load)), true);
  selectThread("a");
  selectThread("e");
  const next = applyEvents(useApp.getState(), [load("f")]);
  assert.ok(next.loaded.a);
  assert.ok(next.loaded.e);
  assert.equal(next.loaded.b, undefined);
  assert.ok(next.loaded.f);
  useApp.setState(initial, true);
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

test("Markdown images resolve workspace paths and leave remote sources alone", async () => {
  const { renderMarkdown } = await import("../web/src/lib/markdown.ts");
  const assets = { projectId: "project", threadId: "thr_chat" };
  const html = await renderMarkdown("![chart](charts/out.png)\n\n![remote](https://example.test/a.png)\n\n![cdn](//cdn.example.com/image.png)", "dark", undefined, assets);
  assert.match(html, /<img src="\/api\/assets\?projectId=project&amp;threadId=thr_chat&amp;path=charts%2Fout\.png" alt="chart"/);
  assert.match(html, /<img src="https:\/\/example\.test\/a\.png" alt="remote"/);
  assert.match(html, /<img src="\/\/cdn\.example\.com\/image\.png" alt="cdn"/);
  const bare = await renderMarkdown("![chart](charts/out.png)", "dark");
  assert.match(bare, /<img src="charts\/out\.png" alt="chart"/);
});
