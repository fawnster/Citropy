import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

test("subagent completion alerts are opt-in and notify once per run", async () => {
  process.env.CITROPY_DATA_DIR = fs.mkdtempSync(join(os.tmpdir(), "citropy-subagent-notify-"));
  const { store } = await import("../server/store.ts");
  const { bus } = await import("../server/bus.ts");
  const events = [];
  bus.subscribe((event) => event.t === "notification.add" && events.push(event.notification));
  const create = (extra = {}) => store.createThread({ projectId: "project", provider: "claude", title: "Review the parser", permissionMode: "manual", ...extra });
  const say = (id, text) => store.addMessage(id, { id: `msg-${id}-${store.threads.get(id).messages.length}`, ts: Date.now(), role: "assistant", parts: [{ id: "prt", kind: "text", text }] });
  const start = (id) => store.patchThread(id, { status: "working", running: true, runStartedAt: Date.now() });
  const parent = create();

  assert.equal(store.notificationPreferences.subagents, false);
  const quietChild = create({ parentThreadId: parent.id });
  start(quietChild.id);
  say(quietChild.id, "Results stay available without an alert.");
  store.patchThread(quietChild.id, { status: "idle", running: false });
  assert.equal(events.length, 0);
  assert.equal(store.threads.get(quietChild.id).messages.at(-1).parts[0].text, "Results stay available without an alert.");
  start(quietChild.id);
  store.patchThread(quietChild.id, { status: "error", running: false, error: "Failed without an alert." });
  assert.equal(events.length, 0);
  store.updateSubagent(parent.id, { id: "quiet-native", title: "Native", status: "working" });
  store.updateSubagent(parent.id, { id: "quiet-native", status: "idle", result: "Native result." });
  assert.equal(events.length, 0);
  assert.equal([...store.threads.values()].find((entry) => entry.nativeAgentId === "quiet-native").messages.at(-1).parts[0].text, "Native result.");
  store.configureNotifications({ subagents: true });

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

function setup() {
  process.env.CITROPY_DATA_DIR ??= fs.mkdtempSync(join(os.tmpdir(), "citropy-subagent-notify-"));
  return Promise.all([import("../server/store.ts"), import("../server/bus.ts")]).then(([{ store }, { bus }]) => {
    const events = [];
    bus.subscribe((event) => event.t === "notification.add" && events.push(event.notification));
    const create = (extra = {}) => store.createThread({ projectId: "project", provider: "claude", title: "Child", permissionMode: "manual", ...extra });
    return { store, events, create };
  });
}

test("a stopped subagent produces no notification", async () => {
  const { store, events, create } = await setup();
  const parent = create();
  const child = create({ parentThreadId: parent.id });
  store.patchThread(child.id, { status: "working", running: true, runStartedAt: Date.now() });
  store.patchThread(child.id, { status: "stopped", running: false });
  assert.equal(events.length, 0);
});

test("deleting a parent with running children leaves no notification aimed at it", async () => {
  const { store, create } = await setup();
  const parent = create();
  const children = [create({ parentThreadId: parent.id }), create({ parentThreadId: parent.id })];
  for (const child of children) store.patchThread(child.id, { status: "working", running: true, runStartedAt: Date.now() });
  const finished = create({ parentThreadId: parent.id });
  store.patchThread(finished.id, { status: "working", running: true });
  store.patchThread(finished.id, { status: "idle", running: false });
  assert.ok(store.notifications.some((entry) => entry.target.threadId === parent.id));
  for (const child of children) store.patchThread(child.id, { status: "stopped", running: false });
  store.removeThread(parent.id);
  assert.equal(store.notifications.filter((entry) => entry.target.threadId === parent.id).length, 0);
  assert.equal(store.threads.has(parent.id), false);
});

test("a native subagent that retries after an in-place edit notifies again", async () => {
  const { store, events, create } = await setup();
  const parent = create();
  const before = events.length;
  store.updateSubagent(parent.id, { id: "native-1", title: "Native", prompt: "Do it", status: "working", result: "First answer." });
  store.updateSubagent(parent.id, { id: "native-1", status: "idle" });
  const lastId = [...store.threads.values()].find((entry) => entry.nativeAgentId === "native-1").messages.at(-1).id;
  store.updateSubagent(parent.id, { id: "native-1", status: "working" });
  store.updateSubagent(parent.id, { id: "native-1", status: "idle", result: "Retried answer." });
  const child = [...store.threads.values()].find((entry) => entry.nativeAgentId === "native-1");
  assert.equal(child.messages.at(-1).id, lastId);
  assert.equal(events.length - before, 2);
  assert.notEqual(events.at(-1).dedupeKey, events.at(-2).dedupeKey);
});

test("two runs started back to back both notify", async () => {
  const { store, events, create } = await setup();
  const parent = create();
  const child = create({ parentThreadId: parent.id });
  const before = events.length;
  const now = Date.now();
  for (let run = 0; run < 3; run++) {
    store.patchThread(child.id, { status: "working", running: true, runStartedAt: now });
    store.patchThread(child.id, { status: "idle", running: false });
  }
  assert.equal(events.length - before, 3);
  assert.equal(new Set(events.slice(before).map((entry) => entry.dedupeKey)).size, 3);
});

test("turning subagent alerts off takes effect for a running child and persists", async () => {
  const { store, events, create } = await setup();
  const { Store } = await import("../server/store.ts");
  const parent = create();
  const child = create({ parentThreadId: parent.id });
  store.configureNotifications({ subagents: true });
  assert.equal(new Store().notificationPreferences.subagents, true);
  store.patchThread(child.id, { status: "working", running: true });
  store.configureNotifications({ subagents: false });
  store.patchThread(child.id, { status: "idle", running: false });
  assert.equal(events.length, 0);
  assert.equal(new Store().notificationPreferences.subagents, false);
  assert.throws(() => store.configureNotifications({ subagents: "yes" }), /Invalid notification preferences/);
});

test("existing notification settings default subagent alerts to off", async () => {
  const { Store } = await import("../server/store.ts");
  const path = join(process.env.CITROPY_DATA_DIR, "settings.json");
  const settings = JSON.parse(fs.readFileSync(path, "utf8"));
  delete settings.notifications.subagents;
  settings.notifications.desktop = false;
  settings.notifications.sound = true;
  fs.writeFileSync(path, JSON.stringify(settings));
  const restored = new Store();
  assert.equal(restored.notificationPreferences.subagents, false);
  assert.equal(restored.notificationPreferences.desktop, false);
  assert.equal(restored.notificationPreferences.sound, true);
});
