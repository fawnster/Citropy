import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = await mkdtemp(join(tmpdir(), "citropy-store-persistence-"));
process.env.CITROPY_DATA_DIR = join(root, "data");
const { store, persistenceStats } = await import("../server/store.ts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("thread persistence is durable on flush and adaptive when scheduled", async (t) => {
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
  await sleep(900);
  assert.equal(existsSync(scheduledPath), true);
  assert.equal(JSON.parse(readFileSync(scheduledPath, "utf8")).messages[0].parts[0].text, "timer persistence");
  assert.ok(persistenceStats().writes > scheduledBefore.writes);
});
