import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = await mkdtemp(join(tmpdir(), "citropy-store-persistence-"));
process.env.CITROPY_DATA_DIR = join(root, "data");
const { store, persistenceStats } = await import("../server/store.ts");

test("thread persistence is durable on flush and adaptive when scheduled", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(async () => {
    store.flush();
    await rm(root, { recursive: true, force: true });
  });

  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const project = store.openProject(workspace);
  const thread = store.createThread({ projectId: project.id, provider: "opencode", title: "Persistence", permissionMode: "manual" });
  const message = store.addMessage(thread.id, { id: "m1", role: "assistant", ts: Date.now(), parts: [{ id: "p1", kind: "text", text: "streaming" }] });
  store.appendText(thread.id, message.id, "p1", " more text");

  const path = join(root, "data", "threads", `${thread.id}.json`);
  store.flush();
  assert.equal(existsSync(path), true);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).messages[0].parts[0].text, "streaming more text");

  const before = persistenceStats();
  store.appendText(thread.id, message.id, "p1", "");
  store.flush();
  const after = persistenceStats();
  assert.equal(after.writes, before.writes);
  assert.equal(after.skipped, before.skipped + 1);

  const scheduled = store.createThread({ projectId: project.id, provider: "opencode", title: "Scheduled", permissionMode: "manual" });
  const scheduledMessage = store.addMessage(scheduled.id, { id: "m2", role: "assistant", ts: Date.now(), parts: [{ id: "p2", kind: "text", text: "timer" }] });
  store.appendText(scheduled.id, scheduledMessage.id, "p2", " persistence");
  const scheduledPath = join(root, "data", "threads", `${scheduled.id}.json`);
  const scheduledBefore = persistenceStats();
  assert.equal(existsSync(scheduledPath), false);
  t.mock.timers.tick(399);
  assert.equal(existsSync(scheduledPath), false);
  t.mock.timers.tick(1);
  assert.equal(existsSync(scheduledPath), true);
  assert.equal(JSON.parse(readFileSync(scheduledPath, "utf8")).messages[0].parts[0].text, "timer persistence");
  assert.ok(persistenceStats().writes > scheduledBefore.writes);

  await t.test("live updates avoid scanning old history and older parts remain editable", () => {
    const entry = store.createThread({ projectId: project.id, provider: "opencode", title: "Long history", permissionMode: "manual" });
    const messages = Array.from({ length: 1000 }, (_, index) => ({
      id: `history-message-${index}`, role: "assistant", ts: index,
      parts: [{ id: `history-part-${index}`, kind: "text", text: "History" }],
    }));
    const current = messages.at(-1);
    current.parts = Array.from({ length: 1000 }, (_, index) => ({ id: `current-part-${index}`, kind: "text", text: "" }));
    store.replaceMessages(entry.id, messages);
    let inspectedIds = 0;
    for (const value of [...messages, ...current.parts]) {
      const id = value.id;
      Object.defineProperty(value, "id", { enumerable: true, get() { inspectedIds++; return id; } });
    }
    for (let index = 0; index < 50; index++) store.appendText(entry.id, "history-message-999", "current-part-999", "delta ");
    store.patchPart(entry.id, "history-message-999", "current-part-999", { complete: true });
    assert.ok(inspectedIds <= 102, `${inspectedIds} IDs inspected for 51 live updates`);
    assert.equal(current.parts.at(-1).text, "delta ".repeat(50));
    assert.equal(current.parts.at(-1).complete, true);
    store.patchPart(entry.id, "history-message-0", "history-part-0", { text: "Updated older message" });
    assert.equal(messages[0].parts[0].text, "Updated older message");
    store.patchPart(entry.id, "history-message-999", "current-part-0", { text: "Updated older part" });
    assert.equal(current.parts[0].text, "Updated older part");
    assert.throws(() => store.appendText(entry.id, "missing-message", "missing-part", "delta"), /unknown message/);
    assert.throws(() => store.appendText(entry.id, "history-message-999", "missing-part", "delta"), /unknown part/);
    store.flush();
    const recovered = JSON.parse(readFileSync(join(root, "data", "threads", `${entry.id}.json`), "utf8"));
    assert.equal(recovered.messages[0].parts[0].text, "Updated older message");
    assert.equal(recovered.messages.at(-1).parts.at(-1).text, "delta ".repeat(50));
  });
});
