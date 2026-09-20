import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

test("a finishing subagent notifies its parent conversation once per run", async () => {
  process.env.CITROPY_DATA_DIR = fs.mkdtempSync(join(os.tmpdir(), "citropy-subagent-notify-"));
  const { store } = await import("../server/store.ts");
  const { bus } = await import("../server/bus.ts");
  const events = [];
  bus.subscribe((event) => event.t === "notification.add" && events.push(event.notification));
  const create = (extra = {}) => store.createThread({ projectId: "project", provider: "claude", title: "Review the parser", permissionMode: "manual", ...extra });
  const say = (id, text) => store.addMessage(id, { id: `msg-${id}-${store.threads.get(id).messages.length}`, ts: Date.now(), role: "assistant", parts: [{ id: "prt", kind: "text", text }] });
  const start = (id) => store.patchThread(id, { status: "working", running: true, runStartedAt: Date.now() });
  const parent = create();

  const child = create({ parentThreadId: parent.id });
  start(child.id);
  say(child.id, "Mapped every call site. ".repeat(20) + "All tests pass.");
  store.patchThread(child.id, { status: "working", running: true });
  assert.equal(events.length, 0);
  store.patchThread(child.id, { status: "idle", running: false });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].target, { view: "chat", projectId: "project", threadId: parent.id });
  assert.equal(events[0].kind, "chat");
  assert.equal(events[0].level, "success");
  assert.match(events[0].title, /^Review the parser/);
  assert.match(events[0].text, /All tests pass\.$/);
  assert.ok(events[0].text.length <= 160);
  assert.equal(store.notifications.filter((entry) => entry.dedupeKey === events[0].dedupeKey).length, 1);

  store.patchThread(child.id, { status: "idle", running: false });
  store.patchThread(child.id, { status: "stopped", running: false });
  assert.equal(events.length, 1);

  start(child.id);
  say(child.id, "Second attempt.");
  store.patchThread(child.id, { status: "idle", running: false });
  assert.equal(events.length, 2);
  assert.notEqual(events[1].dedupeKey, events[0].dedupeKey);

  const failing = create({ parentThreadId: parent.id, title: "x".repeat(200) });
  start(failing.id);
  store.patchThread(failing.id, { status: "error", running: false, error: "Provider rejected the request." });
  assert.equal(events.length, 3);
  assert.equal(events[2].level, "error");
  assert.match(events[2].text, /Provider rejected the request\./);
  assert.ok(events[2].title.length <= 80);
  assert.deepEqual(events[2].target, { view: "chat", projectId: "project", threadId: parent.id });

  const topLevel = create();
  start(topLevel.id);
  store.patchThread(topLevel.id, { status: "idle", running: false });
  assert.equal(events.length, 3);
});
