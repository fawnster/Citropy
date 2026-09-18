import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const root = await mkdtemp(join(tmpdir(), "citropy-checkpoints-"));
process.env.CITROPY_DATA_DIR = join(root, "data");
const cwd = join(root, "workspace");
execFileSync("git", ["init", cwd], { stdio: "ignore" });
const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" } });
const original = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n") + "\n";
await writeFile(join(cwd, "sample.txt"), original);
await writeFile(join(cwd, "other.txt"), "Original\n");
git("add", "."); git("commit", "-m", "Initial");
const { store } = await import("../server/store.ts");
const { eventJournal } = await import("../server/event-journal.ts");
const { beginCheckpoint, finishCheckpoint, reviewChanges, restoreCheckpoint, redoCheckpoint, forkConversation } = await import("../server/checkpoints.ts");
const { changeHunk } = await import("../server/review.ts");
const project = store.openProject(cwd);
const thread = store.createThread({ projectId: project.id, provider: "opencode", title: "Change sample", permissionMode: "manual" });
const changed = original.replace("line 1\n", "changed first\n").replace("line 28\n", "changed last\n");

test("turn review, safe undo and redo preserve unrelated changes and the user index", async () => {
  await beginCheckpoint(thread, "message1");
  store.addMessage(thread.id, { id: "message1", role: "user", parts: [{ id: "prompt1", kind: "text", text: "Change sample" }], ts: Date.now() });
  await writeFile(join(cwd, "sample.txt"), changed);
  await writeFile(join(cwd, "new file.txt"), "Added by the turn\n");
  await finishCheckpoint(thread);
  const review = await reviewChanges(thread, "lastTurn");
  assert.deepEqual(review.patches.map(patch => patch.path).sort(), ["new file.txt", "sample.txt"]);
  assert.equal(review.patches.find(patch => patch.path === "sample.txt").hunks.length, 2);
  await writeFile(join(cwd, "other.txt"), "User's later edit\n");
  await restoreCheckpoint(thread, "message1", "both");
  assert.equal(await readFile(join(cwd, "sample.txt"), "utf8"), original);
  await assert.rejects(readFile(join(cwd, "new file.txt")), /ENOENT/);
  assert.equal(await readFile(join(cwd, "other.txt"), "utf8"), "User's later edit\n");
  assert.equal(git("diff", "--cached"), "");
  assert.equal(thread.messages.length, 0);
  assert.equal(thread.canRedo, true);
  await redoCheckpoint(thread);
  assert.equal(await readFile(join(cwd, "sample.txt"), "utf8"), changed);
  assert.equal(thread.messages.length, 1);
  await writeFile(join(cwd, "sample.txt"), changed + "later manual edit\n");
  await assert.rejects(restoreCheckpoint(thread, "message1", "both"), /edits were preserved/);
  assert.match(await readFile(join(cwd, "sample.txt"), "utf8"), /later manual edit/);
  assert.equal(thread.messages.length, 1);
  await writeFile(join(cwd, "sample.txt"), changed);
});

test("hunk actions stage one change and reject a stale review", async () => {
  const review = await reviewChanges(thread, "unstaged");
  await changeHunk(thread, { scope: "unstaged", path: "sample.txt", index: 0, revision: review.revision, operation: "stage" });
  assert.match(git("diff", "--cached"), /changed first/);
  assert.doesNotMatch(git("diff", "--cached"), /changed last/);
  await assert.rejects(changeHunk(thread, { scope: "unstaged", path: "sample.txt", index: 0, revision: review.revision, operation: "stage" }), /Refresh/);
  const staged = await reviewChanges(thread, "staged");
  await changeHunk(thread, { scope: "staged", path: "sample.txt", index: 0, revision: staged.revision, operation: "unstage" });
  assert.equal(git("diff", "--cached"), "");
});

test("forks preserve source history and use independent provider sessions", async () => {
  const fork = await forkConversation(thread, "message1");
  assert.notEqual(fork.id, thread.id);
  assert.equal(fork.branchedFrom.threadId, thread.id);
  assert.equal(fork.externalId, undefined);
  assert.equal(fork.rebuildContext, true);
  assert.notEqual(fork.messages[0].id, thread.messages[0].id);
  fork.messages[0].parts[0].text = "Changed in fork";
  assert.equal(thread.messages[0].parts[0].text, "Change sample");
});

test("file restore refuses an active agent sharing the workspace", async () => {
  const other = store.createThread({ projectId: project.id, provider: "opencode", title: "Other", permissionMode: "manual" });
  store.patchThread(other.id, { running: true });
  await assert.rejects(restoreCheckpoint(thread, "message1", "files"), /Stop the agents/);
  store.patchThread(other.id, { running: false });
});

test("a finished turn lists the image files it created", async () => {
  await beginCheckpoint(thread, "message2");
  store.addMessage(thread.id, { id: "message2", role: "user", parts: [{ id: "prompt2", kind: "text", text: "Draw a chart" }], ts: Date.now() });
  store.addMessage(thread.id, { id: "assistant2", role: "assistant", parts: [], ts: Date.now() });
  await writeFile(join(cwd, "chart.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(cwd, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(join(cwd, "notes.txt"), "Not an image");
  await finishCheckpoint(thread, "assistant2");
  const part = thread.messages.find(message => message.id === "assistant2")?.parts.at(-1);
  assert.equal(part?.kind, "images");
  assert.deepEqual(part.files.map(file => file.path).sort(), ["chart.png", "logo.svg"]);
  assert.ok(part.files.every(file => file.label && !file.label.includes("/")));
});

test.after(async () => { store.flush(); eventJournal.close(); await rm(root, { recursive: true, force: true }); });
