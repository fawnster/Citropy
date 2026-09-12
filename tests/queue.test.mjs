import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";

async function waitFor(check) {
  for (let i = 0; i < 200; i++) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for state");
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test("follow-ups wait in a visible queue and each provider can take one mid-run", async (t) => {
  const directory = fs.mkdtempSync(join(os.tmpdir(), "citropy-queue-"));
  const originalHomedir = os.homedir;
  os.homedir = () => directory;
  syncBuiltinESMExports();
  const { store, Store } = await import("../server/store.ts");
  const { providers } = await import("../server/providers/index.ts");
  const { disposeAll, runtimeFor } = await import("../server/runtime.ts");
  const sessions = [];
  let steering = true;
  for (const provider of Object.values(providers)) {
    provider.start = (options) => {
      const session = { options, sent: [], steered: [] };
      sessions.push(session);
      return {
        send(text) {
          session.sent.push(text);
        },
        ...(steering ? { async steer(text) { session.steered.push(text); } } : {}),
        interrupt() {},
        dispose() {},
      };
    };
  }
  t.after(async () => {
    disposeAll();
    store.flush();
    os.homedir = originalHomedir;
    syncBuiltinESMExports();
    await new Promise((resolve) => setTimeout(resolve, 450));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const project = store.openProject(directory);
  const start = async (provider = "claude") => {
    const thread = store.createThread({ projectId: project.id, provider, title: "Queue", permissionMode: "manual" });
    const runtime = runtimeFor(thread.id);
    await runtime.send("First");
    return { thread, runtime, session: sessions.at(-1) };
  };
  const texts = (thread) => (thread.queue ?? []).map((item) => item.text);
  const userTexts = (thread) => thread.messages.filter((message) => message.role === "user").map((message) => message.parts[0].text);

  await t.test("messages sent during a run wait, then send one at a time in order", async () => {
    const { thread, runtime, session } = await start();
    assert.equal(thread.status, "queued");
    session.options.emit({ type: "block.start", blockId: "reply", block: "text" });
    assert.equal(thread.status, "thinking");
    await runtime.send("Second");
    await runtime.send("Third");
    assert.deepEqual(session.sent, ["First"]);
    assert.deepEqual(texts(thread), ["Second", "Third"]);
    assert.deepEqual(userTexts(thread), ["First"]);
    session.options.emit({ type: "turn.end" });
    await waitFor(() => session.sent.length === 2);
    assert.deepEqual(texts(thread), ["Third"]);
    assert.deepEqual(userTexts(thread), ["First", "Second"]);
    assert.equal(thread.running, true);
    session.options.emit({ type: "turn.end" });
    await waitFor(() => session.sent.length === 3);
    assert.deepEqual(texts(thread), []);
    session.options.emit({ type: "turn.end" });
    assert.equal(thread.running, false);
  });

  await t.test("stopping keeps queued messages until a later reply finishes", async () => {
    const { thread, runtime, session } = await start("codex");
    await runtime.send("Held");
    runtime.stop();
    session.options.emit({ type: "turn.end" });
    await settle();
    assert.deepEqual(session.sent, ["First"]);
    assert.deepEqual(texts(thread), ["Held"]);
    assert.equal(thread.running, false);
    await runtime.send("Fresh");
    assert.deepEqual(session.sent, ["First", "Fresh"]);
    assert.deepEqual(texts(thread), ["Held"]);
    session.options.emit({ type: "turn.end" });
    await waitFor(() => session.sent.length === 3);
    assert.deepEqual(session.sent, ["First", "Fresh", "Held"]);
  });

  await t.test("a reply that ends in an error pauses the queue until one is sent", async () => {
    const { thread, runtime, session } = await start();
    await runtime.send("Waiting");
    session.options.emit({ type: "turn.end", error: "Rate limited" });
    await settle();
    assert.deepEqual(texts(thread), ["Waiting"]);
    assert.equal(thread.status, "error");
    await runtime.sendNow(thread.queue[0].id);
    assert.deepEqual(session.sent, ["First", "Waiting"]);
    assert.deepEqual(texts(thread), []);
    assert.equal(thread.running, true);
  });

  await t.test("send now hands a message to the run in progress and refuses commands", async () => {
    const { thread, runtime, session } = await start();
    await runtime.send("/review");
    await runtime.send("Also check the tests");
    const [command, note] = thread.queue;
    await runtime.sendNow(note.id);
    assert.deepEqual(session.steered, ["Also check the tests"]);
    assert.deepEqual(session.sent, ["First"]);
    assert.deepEqual(texts(thread), ["/review"]);
    assert.deepEqual(userTexts(thread), ["First", "Also check the tests"]);
    await assert.rejects(runtime.sendNow(command.id), /Commands wait/);
    await assert.rejects(runtime.sendNow("missing"), /already sent or removed/);
    assert.deepEqual(texts(thread), ["/review"]);
  });

  await t.test("a provider without a mid-run method keeps the message queued", async () => {
    steering = false;
    const { thread, runtime } = await start("opencode");
    steering = true;
    await runtime.send("Later");
    await assert.rejects(runtime.sendNow(thread.queue[0].id), /OpenCode can't take a message until it finishes/);
    assert.deepEqual(texts(thread), ["Later"]);
  });

  await t.test("queued messages can be reordered, taken back to edit, removed with their files, and survive a restart", async () => {
    const { thread, runtime } = await start();
    const id = "0f8b6a52-3f5c-4c55-9d0a-1c2b3d4e5f60";
    const folder = join(directory, ".citropy", "attachments", thread.id, id);
    fs.mkdirSync(join(folder, "content"), { recursive: true });
    const file = { id, path: join(folder, "content", "notes.txt"), label: "notes.txt", size: 5, mime: "text/plain" };
    fs.writeFileSync(file.path, "notes");
    fs.writeFileSync(join(folder, "metadata.json"), JSON.stringify(file));
    await runtime.send("One");
    await runtime.send("Two", [file]);
    await runtime.send("Three");
    const [one, two, three] = thread.queue;
    runtime.moveQueued(three.id, 0);
    assert.deepEqual(texts(thread), ["Three", "One", "Two"]);
    assert.throws(() => runtime.moveQueued(one.id, 5), /inside the queue/);
    assert.equal(runtime.takeQueued(one.id).text, "One");
    assert.deepEqual(texts(thread), ["Three", "Two"]);
    assert.deepEqual(thread.queue[1].attachments.map((entry) => entry.label), ["notes.txt"]);
    await runtime.removeQueued(two.id);
    assert.deepEqual(texts(thread), ["Three"]);
    assert.equal(fs.existsSync(folder), false);
    assert.throws(() => runtime.takeQueued(two.id), /already sent or removed/);
    store.flush();
    assert.deepEqual(texts(new Store().threads.get(thread.id)), ["Three"]);
  });

  await t.test("a queued message that can no longer be sent stays queued and pauses the queue", async () => {
    const { thread, runtime, session } = await start();
    await runtime.send("Blocked");
    store.disabledProviders.add("claude");
    try {
      session.options.emit({ type: "turn.end" });
      await waitFor(() => thread.status === "error");
      assert.match(thread.error, /provider is disabled/);
      assert.deepEqual(texts(thread), ["Blocked"]);
      assert.deepEqual(session.sent, ["First"]);
    } finally {
      store.disabledProviders.delete("claude");
    }
  });
});
