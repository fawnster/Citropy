import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";

test("transfers start a fresh agent in the same chat with durable context and separate usage", async t => {
  const directory = fs.mkdtempSync(join(os.tmpdir(), "citropy-transfer-"));
  const originalHome = os.homedir;
  os.homedir = () => directory;
  syncBuiltinESMExports();
  const { store, Store } = await import("../server/store.ts");
  const { providers } = await import("../server/providers/index.ts");
  const { runtimeFor, disposeAll, disposeRuntime } = await import("../server/runtime.ts");
  const { handleFeatures } = await import("../server/features.ts");
  const { usageReport } = await import("../server/usage.ts");
  const { emptyUsage } = await import("../shared/protocol.ts");
  const { stopProcess } = await import("../server/providers/process.ts");
  const sessions = [];
  let failStart = false;
  const catalog = Object.values(providers).map(provider => {
    provider.models = [{ id: `${provider.id}-first`, label: `${provider.label} First`, isDefault: true, contextMax: 128000 }, { id: `${provider.id}-second`, label: `${provider.label} Second`, contextMax: 200000 }];
    provider.start = options => {
      if (failStart) throw new Error("Fixture startup failed");
      const session = { options, sent: [] };
      sessions.push(session);
      return {
        send(prompt) { session.sent.push(prompt); },
        interrupt() {},
        dispose() { session.disposed = true; session.onDispose?.(); },
      };
    };
    return { id: provider.id, label: provider.label, models: provider.models, available: true, enabled: true };
  });
  const project = store.openProject(directory);
  const server = http.createServer((req, res) => void handleFeatures(req, res, catalog));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const transfer = async (thread, provider, model = `${provider}-first`) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/threads/transfer?threadId=${thread.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider, model }) });
    return { status: response.status, data: await response.json() };
  };
  const create = () => {
    const thread = store.createThread({ projectId: project.id, provider: "claude", model: "claude-first", title: "Transfer fixture", permissionMode: "plan", workspacePath: directory, workspaceBranch: "feature/transfer" });
    store.addMessage(thread.id, { id: `${thread.id}-user`, role: "user", ts: 1, parts: [{ id: `${thread.id}-request`, kind: "text", text: "Keep the original constraints and finish the export." }], attachments: [{ path: "/example/spec.txt", label: "spec.txt" }] });
    store.addMessage(thread.id, { id: `${thread.id}-assistant`, role: "assistant", ts: 2, parts: [{ id: `${thread.id}-answer`, kind: "text", text: "The export still needs validation." }] });
    store.patchThread(thread.id, { externalId: "old-session", usage: { ...emptyUsage(), input: 100, output: 20, cacheRead: 60, cacheWrite: 10, costUsd: 0.4, contextTokens: 50000, contextMax: 1000000, turns: 2 } });
    return thread;
  };
  const finish = async (thread, session) => {
    session.options.emit({ type: "turn.end" });
    for (let i = 0; i < 100 && runtimeFor(thread.id).busy; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(runtimeFor(thread.id).busy, false);
  };
  t.after(async () => {
    disposeAll();
    store.flush();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    os.homedir = originalHome;
    syncBuiltinESMExports();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await t.test("cross-provider and same-provider transfers preserve history, settings and usage attribution", async () => {
    const thread = create();
    const originalCount = store.threads.size;
    await runtimeFor(thread.id).send("Keep going");
    const old = sessions.at(-1);
    await finish(thread, old);
    assert.equal((await transfer(thread, "codex")).status, 200);
    const next = sessions.at(-1);
    assert.equal(store.threads.size, originalCount);
    assert.equal(old.disposed, true);
    assert.equal(next.options.externalId, undefined);
    assert.equal(next.options.cwd, directory);
    assert.equal(next.options.permissionMode, "plan");
    assert.equal(thread.workspaceBranch, "feature/transfer");
    assert.equal(next.options.contextMax, 128000);
    assert.deepEqual(next.options.usage, emptyUsage());
    assert.match(next.sent[0], /new agent taking over/);
    assert.match(next.sent[0], /original constraints/);
    assert.match(next.sent[0], /spec.txt/);
    assert.match(next.sent[0], /Never repeat a recorded command/);
    assert.equal(thread.messages[1].provider, "claude");
    assert.equal(thread.messages[1].model, "claude-first");
    assert.equal(thread.transfers[0].externalId, "old-session");
    old.options.emit({ type: "session", externalId: "late-old-event" });
    assert.equal(thread.externalId, undefined);
    next.options.emit({ type: "session", externalId: "codex-session" });
    next.options.emit({ type: "usage", usage: { input: 200, output: 30, cacheRead: 80, contextTokens: 2000 } });
    await finish(thread, next);
    const report = await usageReport([]);
    assert.equal(report.totals.input, 370);
    assert.equal(report.totals.output, 50);
    assert.equal(report.totals.cacheRead, 140);
    assert.equal(report.conversations.find(entry => entry.provider === "claude").usage.costUsd, 0.4);
    assert.equal(report.conversations.find(entry => entry.provider === "codex").usage.input, 200);
    assert.equal((await transfer(thread, "codex", "codex-second")).status, 200);
    assert.equal(next.disposed, true);
    assert.equal(sessions.at(-1).options.externalId, undefined);
    assert.equal(thread.transfers.length, 2);
    assert.equal(thread.transfers[1].usage.input, 200);
    await finish(thread, sessions.at(-1));
    assert.equal((await transfer(thread, "opencode")).status, 200);
    assert.equal(thread.provider, "opencode");
    assert.equal(sessions.at(-1).options.externalId, undefined);
    await finish(thread, sessions.at(-1));
    store.flush();
    const restored = new Store().threads.get(thread.id);
    assert.deepEqual(restored.transfers, JSON.parse(JSON.stringify(thread.transfers)));
  });

  await t.test("invalid, busy, queued and managed chats cannot transfer", async () => {
    const thread = create();
    for (const [provider, model] of [["missing", "model"], ["codex", "missing"], ["claude", "claude-first"]]) {
      assert.equal((await transfer(thread, provider, model)).status, 400);
      assert.equal(thread.provider, "claude");
    }
    for (const patch of [{ running: true }, { compacting: true }, { parentThreadId: "parent" }, { nativeAgentId: "child" }, { queue: [{ id: "queued", text: "Pending request", createdAt: 1 }] }]) {
      store.patchThread(thread.id, patch);
      assert.equal((await transfer(thread, "codex")).status, 400);
      store.patchThread(thread.id, Object.fromEntries(Object.keys(patch).map(key => [key, undefined])));
    }
    catalog[1].enabled = false;
    assert.equal((await transfer(thread, "codex")).status, 400);
    catalog[1].enabled = true;
    const child = store.createThread({ projectId: project.id, provider: "claude", parentThreadId: thread.id, title: "Child", permissionMode: "plan" });
    store.patchThread(child.id, { running: true });
    assert.equal((await transfer(thread, "codex")).status, 400);
    store.patchThread(child.id, { running: false });
    assert.equal(thread.transfers, undefined);
    assert.equal(thread.externalId, "old-session");
    const empty = store.createThread({ projectId: project.id, provider: "claude", title: "Empty", permissionMode: "plan" });
    assert.equal((await transfer(empty, "codex")).status, 400);
  });

  await t.test("large conversations retain a complete transcript and failed startup can be retried", async () => {
    const thread = create();
    thread.messages[1].parts[0].text = "Earlier details. ".repeat(25000);
    failStart = true;
    assert.equal((await transfer(thread, "codex")).status, 400);
    assert.equal(thread.running, false);
    assert.equal(thread.status, "error");
    assert.match(thread.error, /startup failed/);
    assert.ok(thread.transferContext.endsWith(".json"));
    store.flush();
    assert.equal(new Store().threads.get(thread.id).transferContext, thread.transferContext);
    const savedDirectory = join(directory, ".citropy", "transfers", thread.id);
    const transcript = JSON.parse(fs.readFileSync(join(savedDirectory, fs.readdirSync(savedDirectory)[0]), "utf8"));
    assert.equal(transcript.messages[1].parts[0].text, thread.messages[1].parts[0].text);
    failStart = false;
    disposeRuntime(thread.id, true);
    await runtimeFor(thread.id).send("Retry the handoff");
    const session = sessions.at(-1);
    assert.ok(session.sent[0].length < 28000);
    assert.match(session.sent[0], /Read the saved conversation/);
    assert.match(session.sent[0], /Retry the handoff/);
    session.options.emit({ type: "session", externalId: "new-session" });
    await finish(thread, session);
    await runtimeFor(thread.id).send("Now validate the export");
    assert.equal(session.sent[1], "Now validate the export");
    await finish(thread, session);
    disposeRuntime(thread.id, true);
    store.removeThread(thread.id);
    assert.equal(fs.existsSync(savedDirectory), false);
  });

  await t.test("stopping during preparation leaves the original agent intact", async () => {
    const thread = create();
    const runtime = runtimeFor(thread.id);
    const pending = runtime.transfer(catalog[1], "codex-first");
    runtime.stop();
    await assert.rejects(pending, /stopped|cancel/i);
    assert.equal(thread.provider, "claude");
    assert.equal(thread.externalId, "old-session");
    assert.equal(thread.transfers, undefined);
  });

  await t.test("asynchronous provider failures retain the handoff until a response starts", async () => {
    const thread = create();
    assert.equal((await transfer(thread, "codex")).status, 200);
    const session = sessions.at(-1);
    session.options.emit({ type: "session", externalId: "new-but-empty-session" });
    session.options.emit({ type: "turn.end", error: "Provider could not start the turn" });
    assert.ok(thread.transferContext);
    await runtimeFor(thread.id).send("Retry after the connection failure");
    assert.match(session.sent[1], /Read the saved conversation/);
    assert.match(session.sent[1], /original constraints/);
    session.options.emit({ type: "block.start", blockId: "retry-response", block: "text" });
    assert.equal(thread.transferContext, undefined);
    await finish(thread, session);
    await runtimeFor(thread.id).send("Continue validation");
    assert.equal(session.sent[2], "Continue validation");
    await finish(thread, session);
  });

  await t.test("a transfer waits for source shutdown and can be cancelled during that wait", async () => {
    for (const cancel of [false, true]) {
      const thread = create();
      const runtime = runtimeFor(thread.id);
      await runtime.send("Continue the export");
      const old = sessions.at(-1);
      await finish(thread, old);
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      const shutdown = Promise.withResolvers();
      child.kill = () => { shutdown.resolve(); return true; };
      old.onDispose = () => stopProcess(child);
      const count = sessions.length;
      const pending = runtime.transfer(catalog[1], "codex-first");
      try {
        await shutdown.promise;
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(sessions.length, count);
        assert.equal(thread.provider, "claude");
        assert.equal(runtime.busy, true);
        if (cancel) runtime.stop();
      } finally {
        child.emit("exit", 0);
      }
      if (cancel) {
        await assert.rejects(pending, /stopped|cancel/i);
        assert.equal(thread.provider, "claude");
        assert.equal(thread.externalId, "old-session");
        assert.equal(thread.transfers, undefined);
      } else {
        await pending;
        assert.equal(sessions.length, count + 1);
        assert.equal(thread.provider, "codex");
        await finish(thread, sessions.at(-1));
      }
    }
  });
});
