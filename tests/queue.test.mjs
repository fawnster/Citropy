import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";

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
          return session.onSend?.();
        },
        ...(steering ? { async steer(text) { session.steered.push(text); } } : {}),
        interrupt() { return session.onInterrupt?.(); },
        dispose() { session.disposed = true; },
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
  const attachment = (thread) => {
    const id = randomUUID();
    const folder = join(directory, ".citropy", "attachments", thread.id, id);
    fs.mkdirSync(join(folder, "content"), { recursive: true });
    const file = { id, path: join(folder, "content", "notes.txt"), label: "notes.txt", size: 5, mime: "text/plain" };
    fs.writeFileSync(file.path, "notes");
    fs.writeFileSync(join(folder, "metadata.json"), JSON.stringify(file));
    return file;
  };

  await t.test("stopping while preparing a message prevents it from reaching the provider", async () => {
    const thread = store.createThread({ projectId: project.id, provider: "claude", title: "Cancel", permissionMode: "manual" });
    const runtime = runtimeFor(thread.id);
    const previousSessions = sessions.length;
    const sending = runtime.send("Do not dispatch this");
    runtime.stop();
    await assert.rejects(sending, /stopped|cancel/i);
    assert.equal(sessions.length, previousSessions);
    assert.deepEqual(userTexts(thread), []);
    assert.equal(thread.status, "stopped");
    await runtime.send("Fresh request");
    assert.deepEqual(sessions.at(-1).sent, ["Fresh request"]);
  });

  await t.test("an interrupt acknowledgement preserves stopped status and the queue", async () => {
    const { thread, runtime, session } = await start();
    await runtime.send("Held");
    runtime.stop();
    session.options.emit({ type: "turn.end", error: "Interrupted" });
    assert.equal(thread.status, "stopped");
    assert.equal(thread.error, undefined);
    assert.deepEqual(texts(thread), ["Held"]);
  });

  await t.test("continuing immediately waits for the old turn and its stop acknowledgement", async () => {
    for (const provider of ["claude", "codex", "opencode"]) {
      const { thread, runtime, session } = await start(provider);
      const acknowledgement = Promise.withResolvers();
      if (provider === "opencode") session.onInterrupt = () => acknowledgement.promise;
      runtime.stop();
      const continuing = runtime.send("Continue");
      await settle();
      assert.deepEqual(session.sent, ["First"]);
      session.options.emit({ type: "turn.end", error: "fetch failed" });
      if (provider === "opencode") {
        await settle();
        assert.deepEqual(session.sent, ["First"]);
        acknowledgement.resolve();
      }
      await continuing;
      assert.deepEqual(session.sent, ["First", "Continue"]);
      assert.equal(thread.error, undefined);
      assert.equal(thread.running, true);
      session.options.emit({ type: "turn.end" });
    }
  });

  await t.test("attachment validation finishing after the reply does not strand a follow-up", async () => {
    const { thread, runtime, session } = await start();
    const sending = runtime.send("Second", [attachment(thread)]);
    session.options.emit({ type: "turn.end" });
    await sending;
    await waitFor(() => session.sent.length === 2);
    assert.deepEqual(session.sent, ["First", "Second"]);
    assert.deepEqual(texts(thread), []);
    assert.equal(thread.running, true);
  });

  await t.test("an unresponsive stop restarts the session and ignores its late events", async t => {
    const { thread, runtime, session } = await start("opencode");
    session.options.emit({ type: "session", externalId: "resume-this-session" });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    runtime.stop();
    t.mock.timers.tick(5000);
    assert.equal(session.disposed, true);
    t.mock.timers.reset();
    await runtime.send("Continue");
    const replacement = sessions.at(-1);
    assert.notEqual(replacement, session);
    assert.equal(replacement.options.externalId, "resume-this-session");
    session.options.emit({ type: "turn.end", error: "fetch failed" });
    session.options.emit({ type: "exit", code: 1 });
    assert.equal(thread.running, true);
    assert.equal(thread.error, undefined);
    replacement.options.emit({ type: "turn.end" });
  });

  await t.test("stopping again cancels a continuation waiting for the previous stop", async () => {
    const { thread, runtime, session } = await start();
    runtime.stop();
    const continuing = runtime.send("Cancel this continuation");
    const rejected = assert.rejects(continuing, /stopped|cancel/i);
    await settle();
    runtime.stop();
    session.options.emit({ type: "turn.end" });
    await rejected;
    assert.deepEqual(session.sent, ["First"]);
    assert.equal(thread.status, "stopped");
  });

  await t.test("concurrent follow-ups keep arrival order when the first includes attachments", async () => {
    const { thread, runtime } = await start();
    await Promise.all([runtime.send("Second", [attachment(thread)]), runtime.send("Third")]);
    assert.deepEqual(texts(thread), ["Second", "Third"]);
  });

  await t.test("stopping during queue preparation keeps the unsent follow-up", async () => {
    const { thread, runtime, session } = await start();
    await runtime.send("Held");
    session.options.emit({ type: "turn.end" });
    runtime.stop();
    await settle();
    assert.deepEqual(session.sent, ["First"]);
    assert.deepEqual(texts(thread), ["Held"]);
    assert.equal(thread.status, "stopped");
  });

  await t.test("a reply ending before send acknowledgement still advances the queue", async () => {
    const { thread, runtime, session } = await start();
    session.options.emit({ type: "turn.end" });
    let acknowledge;
    const acknowledgement = new Promise(resolve => { acknowledge = resolve; });
    session.onSend = () => acknowledgement;
    const sending = runtime.send("Second");
    await waitFor(() => session.sent.length === 2);
    await runtime.send("Third");
    session.options.emit({ type: "turn.end" });
    session.onSend = undefined;
    acknowledge();
    await sending;
    await waitFor(() => session.sent.length === 3);
    assert.deepEqual(session.sent, ["First", "Second", "Third"]);
    assert.deepEqual(texts(thread), []);
  });

  await t.test("a late send failure cannot turn an interrupted task into an error", async () => {
    const { thread, runtime, session } = await start();
    session.options.emit({ type: "turn.end" });
    let reject;
    session.onSend = () => new Promise((_, fail) => { reject = fail; });
    const sending = runtime.send("Interrupt while sending");
    await waitFor(() => reject);
    runtime.stop();
    reject(new Error("Request interrupted"));
    await assert.rejects(sending, /Request interrupted/);
    assert.equal(thread.status, "stopped");
    assert.equal(thread.error, undefined);
  });

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

  await t.test("a rejected attachment does not block later valid follow-ups", async () => {
    const { thread, runtime, session } = await start();
    const results = await Promise.allSettled([
      runtime.send("Invalid", [{ id: randomUUID() }]),
      runtime.send("Valid"),
    ]);
    assert.equal(results[0].status, "rejected");
    assert.equal(results[1].status, "fulfilled");
    assert.deepEqual(texts(thread), ["Valid"]);
    session.options.emit({ type: "turn.end" });
    await waitFor(() => session.sent.length === 2);
    assert.deepEqual(session.sent, ["First", "Valid"]);
  });

  await t.test("disposing during queue validation prevents stale writes", async () => {
    const { thread, runtime } = await start();
    const sending = runtime.send("Do not enqueue", [attachment(thread)]);
    runtime.dispose();
    await assert.rejects(sending, /closed/);
    assert.deepEqual(texts(thread), []);
    assert.equal(thread.status, "stopped");
  });

  await t.test("bursts of follow-ups drain exactly once in order across providers", async () => {
    for (const provider of ["claude", "codex", "opencode"]) {
      const { thread, runtime, session } = await start(provider);
      const file = attachment(thread);
      const messages = Array.from({ length: 60 }, (_, index) => `Follow-up ${index}`);
      await Promise.all(messages.map((text, index) => runtime.send(text, index % 3 === 0 ? [file] : [])));
      assert.deepEqual(texts(thread), messages);
      for (let index = 0; index < messages.length; index++) {
        session.options.emit({ type: "turn.end" });
        await waitFor(() => session.sent.length === index + 2);
      }
      session.options.emit({ type: "turn.end" });
      assert.deepEqual(session.sent, ["First", ...messages]);
      assert.deepEqual(userTexts(thread), session.sent);
      assert.deepEqual(texts(thread), []);
      assert.equal(thread.running, false);
      assert.equal(thread.status, "idle");
    }
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

  await t.test("an accepted plan leaves plan mode and asks the provider to build it", async () => {
    const thread = store.createThread({ projectId: project.id, provider: "cursor", title: "Plan", permissionMode: "plan" });
    const runtime = runtimeFor(thread.id);
    await runtime.send("Plan a pizza file");
    const planning = sessions.at(-1);
    assert.equal(planning.options.permissionMode, "plan");
    planning.options.emit({ type: "plan.accepted" });
    planning.options.emit({ type: "turn.end" });
    const building = await waitFor(() => sessions.at(-1) !== planning && sessions.at(-1));
    assert.equal(planning.disposed, true);
    assert.equal(building.options.permissionMode, "manual");
    assert.equal(store.threads.get(thread.id).permissionMode, "manual");
    await waitFor(() => building.sent.length);
    assert.match(building.sent[0], /Build the plan\./);
    assert.deepEqual(userTexts(store.threads.get(thread.id)), ["Plan a pizza file", "Build the plan."]);
    building.options.emit({ type: "turn.end" });
    await settle();
  });

  await t.test("a plan accepted before the provider exits is not built by a later turn", async () => {
    const thread = store.createThread({ projectId: project.id, provider: "cursor", title: "Stale plan", permissionMode: "plan" });
    const runtime = runtimeFor(thread.id);
    await runtime.send("Plan a pizza file");
    const planning = sessions.at(-1);
    planning.options.emit({ type: "plan.accepted" });
    planning.options.emit({ type: "exit", code: 0 });
    await waitFor(() => store.threads.get(thread.id).running === false);
    await runtime.send("Continue");
    const next = await waitFor(() => sessions.at(-1) !== planning && sessions.at(-1));
    assert.equal(next.options.permissionMode, "plan");
    next.options.emit({ type: "turn.end" });
    await settle();
    assert.equal(store.threads.get(thread.id).permissionMode, "plan");
    assert.deepEqual(userTexts(store.threads.get(thread.id)), ["Plan a pizza file", "Continue"]);
    assert.equal(sessions.at(-1), next);
  });
});
