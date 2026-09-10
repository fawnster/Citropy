import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import { WebSocket } from "ws";

async function waitFor(check) {
  for (let i = 0; i < 200; i++) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for state");
}

test("conversation persistence and lifecycle recovery", async (t) => {
  const directory = fs.mkdtempSync(join(os.tmpdir(), "citropy-recovery-"));
  const originalHomedir = os.homedir;
  const originalCreateServer = http.createServer;
  const originalRename = fs.renameSync;
  const originalPort = process.env.CITROPY_PORT;
  let server;
  const sockets = [];
  os.homedir = () => directory;
  http.createServer = (...args) => {
    server = originalCreateServer(...args);
    return server;
  };
  syncBuiltinESMExports();
  process.env.CITROPY_PORT = "0";
  globalThis.localStorage = { getItem: () => null };
  const { store, Store } = await import("../server/store.ts");
  const { providers, describeProviders } = await import("../server/providers/index.ts");
  const { disposeAll, disposeRuntime, runtimeFor } = await import("../server/runtime.ts");
  const { pendingRequests } = await import("../server/permissions.ts");
  const { connectTools } = await import("../server/mcp-access.ts");
  const { applyEvent, useApp } = await import("../web/src/lib/store.ts");
  const sessions = [];
  for (const provider of Object.values(providers)) {
    provider.listModels = async () => [{ id: "test", label: "Test", efforts: ["low", "high"] }];
    provider.detect = async () => ({ available: true });
    provider.start = (options) => {
      const session = { options, disposed: false };
      sessions.push(session);
      return {
        send() {},
        interrupt() {},
        dispose() {
          session.disposed = true;
          options.emit({ type: "exit", code: 0 });
        },
      };
    };
  }
  t.after(async () => {
    disposeAll();
    store.flush();
    for (const socket of sockets) socket.terminate();
    if (server) await new Promise((resolve) => server.close(resolve));
    os.homedir = originalHomedir;
    http.createServer = originalCreateServer;
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
    if (originalPort === undefined) delete process.env.CITROPY_PORT;
    else process.env.CITROPY_PORT = originalPort;
    delete globalThis.localStorage;
    await new Promise((resolve) => setTimeout(resolve, 450));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const project = store.openProject(directory);
  const thread = store.createThread({ projectId: project.id, provider: "claude", title: "Recovery", permissionMode: "manual" });
  store.flush();
  const savedPath = join(directory, ".citropy", "threads", `${thread.id}.json`);

  await t.test("a failed replacement preserves the last complete save and can be retried", () => {
    const previous = fs.readFileSync(savedPath, "utf8");
    store.patchThread(thread.id, { title: "Updated" });
    fs.renameSync = () => { throw new Error("simulated failed replacement"); };
    syncBuiltinESMExports();
    try {
      assert.throws(() => store.flush(), /simulated failed replacement/);
      assert.equal(fs.readFileSync(savedPath, "utf8"), previous);
      assert.deepEqual(fs.readdirSync(join(directory, ".citropy", "threads")), [`${thread.id}.json`]);
    } finally {
      fs.renameSync = originalRename;
      syncBuiltinESMExports();
    }
    store.flush();
    assert.equal(JSON.parse(fs.readFileSync(savedPath, "utf8")).title, "Updated");
    assert.equal(new Store().threads.get(thread.id).title, "Updated");
  });

  await t.test("malformed conversation files survive startup while valid files load", () => {
    const damagedPath = join(directory, ".citropy", "threads", "damaged.json");
    fs.writeFileSync(damagedPath, '{"messages":');
    assert.equal(new Store().threads.has(thread.id), true);
    assert.equal(fs.readFileSync(damagedPath, "utf8"), '{"messages":');
  });

  await t.test("conversation saves do not rewrite unchanged workspace settings", () => {
    const writes = [];
    fs.renameSync = (from, to) => { writes.push(to); return originalRename(from, to); };
    syncBuiltinESMExports();
    try {
      store.patchThread(thread.id, { title: "Saved again" });
      store.flush();
      store.flush();
      assert.deepEqual(writes, [savedPath]);
    } finally {
      fs.renameSync = originalRename;
      syncBuiltinESMExports();
    }
  });

  await t.test("failed provider sessions release unfinished tools and cannot modify a restarted turn", async () => {
    const previousSessions = sessions.length;
    const entry = store.createThread({ projectId: project.id, provider: "claude", title: "Lifecycle", permissionMode: "manual" });
    const runtime = runtimeFor(entry.id);
    await runtime.send("First");
    const old = sessions.at(-1);
    old.options.emit({ type: "tool.start", callId: "unfinished", name: "Bash", input: { command: "example" } });
    old.options.emit({ type: "exit", code: 1 });
    assert.equal(old.disposed, true);
    const tool = entry.messages.flatMap((message) => message.parts).find((part) => part.kind === "tool");
    assert.equal(tool.status, "error");
    assert.ok(tool.endedAt);
    await runtime.send("Second");
    const messageCount = entry.messages.length;
    old.options.emit({ type: "block.start", blockId: "late", block: "text" });
    old.options.emit({ type: "exit", code: 0 });
    assert.equal(entry.messages.length, messageCount);
    assert.equal(entry.running, true);
    sessions.at(-1).options.emit({ type: "turn.end" });
    assert.equal(entry.running, false);
    disposeRuntime(entry.id);
    store.removeThread(entry.id);
    sessions.splice(previousSessions);
  });

  await t.test("text blocks become ready before the turn ends and survive interruption", async () => {
    const entry = store.createThread({ projectId: project.id, provider: "claude", title: "Text completion", permissionMode: "manual" });
    const runtime = runtimeFor(entry.id);
    const previousSessions = sessions.length;
    await runtime.send("Start");
    const session = sessions.at(-1);
    session.options.emit({ type: "block.start", blockId: "text", block: "text" });
    session.options.emit({ type: "block.delta", blockId: "text", text: "Complete paragraph" });
    const part = entry.messages.at(-1).parts.at(-1);
    assert.equal(part.complete, false);
    session.options.emit({ type: "block.end", blockId: "text" });
    assert.equal(part.complete, true);
    assert.equal(entry.running, true);
    session.options.emit({ type: "block.start", blockId: "partial", block: "text" });
    session.options.emit({ type: "block.delta", blockId: "partial", text: "Partial paragraph" });
    const partial = entry.messages.at(-1).parts.at(-1);
    session.options.emit({ type: "exit", code: 1 });
    assert.equal(partial.complete, true);
    assert.equal(partial.text, "Partial paragraph");
    disposeRuntime(entry.id);
    store.removeThread(entry.id);
    sessions.splice(previousSessions);
  });

  await import("../server/main.ts");
  if (!server.listening) await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  async function connect() {
    const socket = new WebSocket(url.replace("http", "ws") + "/socket");
    sockets.push(socket);
    const events = [];
    socket.on("message", (data) => events.push(JSON.parse(String(data))));
    await once(socket, "open");
    await waitFor(() => events.find((event) => event.t === "hello"));
    return { socket, events };
  }
  const first = await connect();
  await t.test("catalog refresh keeps the last good models on failure without resetting conversation state", async () => {
    const listModels = providers.claude.listModels;
    try {
      providers.claude.listModels = async () => [{ id: "fresh", label: "Fresh", efforts: ["high"] }];
      const refreshed = await describeProviders();
      assert.equal(refreshed.find((provider) => provider.id === "claude").models[0].id, "fresh");
      providers.claude.listModels = async () => { throw new Error("offline"); };
      const failed = await describeProviders();
      assert.equal(failed.find((provider) => provider.id === "claude").models[0].id, "fresh");
      assert.match(failed.find((provider) => provider.id === "claude").modelsError, /offline/);
      const state = { ...useApp.getState(), loaded: { preview: true }, activeThreadId: "preview" };
      applyEvent(state, { t: "providers.update", providers: failed });
      assert.equal(state.activeThreadId, "preview");
      assert.equal(state.loaded.preview, true);
    } finally {
      providers.claude.listModels = listModels;
      await describeProviders();
    }
  });

  await t.test("effort is validated, saved, and passed to the agent", async () => {
    first.socket.send(JSON.stringify({ t: "thread.config", id: thread.id, model: "test", effort: "high" }));
    await waitFor(() => store.threads.get(thread.id).effort === "high");
    store.flush();
    assert.equal(JSON.parse(fs.readFileSync(savedPath, "utf8")).effort, "high");
    first.socket.send(JSON.stringify({ t: "thread.config", id: thread.id, effort: "unsupported" }));
    await waitFor(() => first.events.find((event) => event.t === "toast" && event.text.includes("not supported")));
    assert.equal(store.threads.get(thread.id).effort, "high");
  });
  let approval;
  await t.test("reload restores a pending approval and reconnect clears resolved approvals", async () => {
    approval = fetch(`${url}/mcp/${thread.id}`, {
      method: "POST",
      headers: { ...connectTools(thread.id).headers, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "approve", arguments: { tool_name: "Read", input: { file_path: "README.md" } } } }),
    }).then((response) => response.json());
    const request = JSON.parse(JSON.stringify(await waitFor(() => pendingRequests()[0])));
    const reloaded = await connect();
    const hello = reloaded.events.find((event) => event.t === "hello");
    assert.deepEqual(hello.snapshot.permissions, [request]);
    const state = { ...useApp.getState() };
    applyEvent(state, hello);
    assert.deepEqual(state.permissions, [request]);
    reloaded.socket.send(JSON.stringify({ t: "permission.answer", id: request.id, decision: "allow" }));
    assert.equal(JSON.parse((await approval).result.content[0].text).behavior, "allow");
    const reconnect = await connect();
    applyEvent(state, reconnect.events.find((event) => event.t === "hello"));
    assert.deepEqual(state.permissions, []);
  });

  await t.test(
    "closing a project disposes only its agents, denies approvals, and ignores late output",
    async () => {
      const otherProject = store.openProject(join(directory, "other"));
      const otherThread = store.createThread({
        projectId: otherProject.id,
        provider: "codex",
        title: "Other",
        permissionMode: "manual",
      });
      for (const id of [thread.id, otherThread.id])
        first.socket.send(
          JSON.stringify({ t: "thread.send", threadId: id, text: "Work" }),
        );
      await waitFor(() => sessions.length === 2);
      assert.equal(
        sessions.find((session) => session.options.threadId === thread.id)
          .options.effort,
        "high",
      );
      approval = fetch(`${url}/mcp/${thread.id}`, {
        method: "POST",
        headers: {
          ...connectTools(thread.id).headers,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "approve",
            arguments: { tool_name: "Write", input: {} },
          },
        }),
      }).then((response) => response.json());
      await waitFor(() => pendingRequests().length === 1);
      first.socket.send(JSON.stringify({ t: "project.close", id: project.id }));
      await waitFor(() => !store.projects.has(project.id));
      const closed = sessions.find(
        (session) => session.options.threadId === thread.id,
      );
      assert.equal(closed.disposed, true);
      assert.equal(
        sessions.find((session) => session.options.threadId === otherThread.id)
          .disposed,
        false,
      );
      first.socket.send(
        JSON.stringify({
          t: "thread.config",
          id: otherThread.id,
          effort: "low",
        }),
      );
      await waitFor(() =>
        first.events.some(
          (event) =>
            event.t === "toast" && /Wait for this turn/.test(event.text),
        ),
      );
      assert.equal(
        sessions.find((session) => session.options.threadId === otherThread.id)
          .disposed,
        false,
      );
      first.socket.send(
        JSON.stringify({ t: "thread.stop", threadId: otherThread.id }),
      );
      await waitFor(() => !store.threads.get(otherThread.id).running);
      first.socket.send(
        JSON.stringify({
          t: "thread.config",
          id: otherThread.id,
          effort: "low",
        }),
      );
      await waitFor(
        () =>
          sessions.find(
            (session) => session.options.threadId === otherThread.id,
          ).disposed,
      );
      assert.equal(store.threads.get(otherThread.id).running, false);
      assert.equal(store.threads.has(thread.id), false);
      assert.equal(fs.existsSync(savedPath), false);
      assert.equal(
        JSON.parse((await approval).result.content[0].text).behavior,
        "deny",
      );
      assert.deepEqual(pendingRequests(), []);
      assert.doesNotThrow(() =>
        closed.options.emit({
          type: "block.start",
          blockId: "late",
          block: "text",
        }),
      );
      assert.doesNotThrow(() =>
        closed.options.emit({
          type: "block.delta",
          blockId: "late",
          text: "late output",
        }),
      );
    },
  );
  await t.test(
    "disabled providers stop only their sessions, persist, and reject new work",
    async () => {
      const disabledProject = store.openProject(join(directory, "providers"));
      const a = store.createThread({
        projectId: disabledProject.id,
        provider: "claude",
        title: "Disabled",
        permissionMode: "manual",
      });
      const b = store.createThread({
        projectId: disabledProject.id,
        provider: "codex",
        title: "Enabled",
        permissionMode: "manual",
      });
      for (const id of [a.id, b.id])
        first.socket.send(
          JSON.stringify({ t: "thread.send", threadId: id, text: "Start" }),
        );
      await waitFor(() =>
        sessions.some((session) => session.options.threadId === b.id),
      );
      const aSession = sessions.find(
        (session) => session.options.threadId === a.id,
      );
      const bSession = sessions.find(
        (session) => session.options.threadId === b.id,
      );
      first.socket.send(
        JSON.stringify({
          t: "providers.configure",
          provider: "claude",
          enabled: false,
        }),
      );
      await waitFor(() => store.disabledProviders.has("claude"));
      assert.equal(aSession.disposed, true);
      assert.equal(bSession.disposed, false);
      assert.equal(store.threads.get(a.id).running, false);
      assert.equal(new Store().disabledProviders.has("claude"), true);
      await waitFor(() => first.events.some((event) => event.t === "providers.update" && event.providers.find((provider) => provider.id === "claude")?.enabled === false));
      assert.equal(
        first.events
          .filter((event) => event.t === "providers.update")
          .at(-1)
          .providers.find((provider) => provider.id === "claude").enabled,
        false,
      );
      const models = providers.claude.listModels;
      const detect = providers.claude.detect;
      providers.claude.detect = async () => {
        throw new Error("Disabled detection must not run");
      };
      providers.claude.listModels = async () => {
        throw new Error("Disabled discovery must not run");
      };
      const info = (await describeProviders()).find(
        (provider) => provider.id === "claude",
      );
      assert.equal(info.enabled, false);
      assert.equal(info.modelsError, undefined);
      providers.claude.listModels = models;
      providers.claude.detect = detect;
      const count = store.threads.get(a.id).messages.length;
      first.socket.send(
        JSON.stringify({ t: "thread.send", threadId: a.id, text: "Blocked" }),
      );
      await waitFor(() =>
        first.events.some(
          (event) =>
            event.t === "toast" && /provider is disabled/.test(event.text),
        ),
      );
      assert.equal(store.threads.get(a.id).messages.length, count);
      assert.throws(
        () =>
          store.createThread({
            projectId: disabledProject.id,
            provider: "claude",
            title: "Blocked",
            permissionMode: "manual",
          }),
        /provider is disabled/,
      );
      first.socket.send(
        JSON.stringify({
          t: "providers.configure",
          provider: "claude",
          enabled: true,
        }),
      );
      await waitFor(() => !store.disabledProviders.has("claude"));
      first.socket.send(
        JSON.stringify({ t: "thread.send", threadId: a.id, text: "Continue" }),
      );
      await waitFor(
        () => store.threads.get(a.id).messages.length === count + 1,
      );
      assert.equal(new Store().disabledProviders.has("claude"), false);
    },
  );

  await t.test("finishing is explicit, persists, and stays separate from selecting a conversation", async () => {
    const finishProject = store.openProject(join(directory, "finish"));
    const a = store.createThread({ projectId: finishProject.id, provider: "codex", model: "test", title: "Finish me", permissionMode: "manual" });
    const b = store.createThread({ projectId: finishProject.id, provider: "codex", model: "test", title: "Keep open", permissionMode: "manual" });
    store.patchThread(a.id, { usage: { ...a.usage, turns: 2 } });
    first.socket.send(JSON.stringify({ t: "thread.load", id: b.id }));
    await waitFor(() => first.events.some((event) => event.t === "thread.messages" && event.threadId === b.id));
    assert.equal(Boolean(a.finished), false);
    const updatedAt = a.updatedAt;
    first.socket.send(JSON.stringify({ t: "thread.finish", id: a.id, finished: true }));
    await waitFor(() => a.finished === true);
    store.flush();
    assert.equal(new Store().threads.get(a.id).finished, true);
    assert.equal(a.updatedAt, updatedAt);
    const reloaded = await connect();
    assert.equal(reloaded.events.find((event) => event.t === "hello").snapshot.threads.find((thread) => thread.id === a.id).finished, true);
    first.socket.send(JSON.stringify({ t: "thread.load", id: a.id }));
    await waitFor(() => first.events.some((event) => event.t === "thread.messages" && event.threadId === a.id));
    assert.equal(a.finished, true);
    first.socket.send(JSON.stringify({ t: "thread.finish", id: a.id, finished: false }));
    await waitFor(() => a.finished === false);
    store.setThreadFinished(a.id, true);
    first.socket.send(JSON.stringify({ t: "thread.send", threadId: a.id, text: "Continue this conversation" }));
    await waitFor(() => a.messages.length === 1);
    assert.equal(a.finished, false);
    assert.equal(a.running, true);
    first.socket.send(JSON.stringify({ t: "thread.finish", id: a.id, finished: true }));
    await waitFor(() => first.events.some((event) => event.t === "toast" && /Stop this conversation/.test(event.text)));
    assert.equal(a.finished, false);
    assert.equal(a.running, true);
    store.flush();
    assert.equal(new Store().threads.get(a.id).finished, false);
    assert.throws(() => store.setThreadFinished(b.id, "true"), /Invalid conversation state/);
  });

  await t.test(
    "completion notices are emitted once, persisted, acknowledged and restored without replaying popups",
    async () => {
      const notifyProject = store.openProject(join(directory, "notifications"));
      const item = store.createThread({
        projectId: notifyProject.id,
        provider: "codex",
        title: "Notification fixture",
        permissionMode: "manual",
      });
      first.socket.send(
        JSON.stringify({
          t: "thread.send",
          threadId: item.id,
          text: "Complete this",
        }),
      );
      const session = await waitFor(() =>
        sessions.find((entry) => entry.options.threadId === item.id),
      );
      const before = store.notifications.length;
      session.options.emit({ type: "turn.end" });
      session.options.emit({ type: "exit", code: 0 });
      assert.equal(store.notifications.length, before + 1);
      const notification = store.notifications[0];
      assert.equal(notification.target.threadId, item.id);
      assert.equal(notification.read, false);
      assert.equal(new Store().notifications[0].id, notification.id);
      const state = { ...useApp.getState(), notifications: [], toasts: [] };
      applyEvent(state, { t: "notification.add", notification });
      applyEvent(state, { t: "notification.add", notification });
      assert.equal(state.toasts.length, 1);
      const reconnected = await connect();
      state.toasts = [];
      applyEvent(
        state,
        reconnected.events.find((event) => event.t === "hello"),
      );
      assert.equal(state.toasts.length, 0);
      assert.equal(state.notifications[0].id, notification.id);
      first.socket.send(
        JSON.stringify({ t: "notifications.read", ids: [notification.id] }),
      );
      await waitFor(() => store.notifications[0].read);
      assert.equal(new Store().notifications[0].read, true);
      store.configureNotifications({ desktop: false, sound: true });
      store.setProviderEnabled("opencode", false);
      assert.equal(new Store().notificationPreferences.desktop, false);
      assert.equal(new Store().notificationPreferences.sound, true);
      assert.throws(
        () => store.configureNotifications({ desktop: "yes" }),
        /Invalid notification/,
      );
      store.clearNotifications();
      assert.equal(
        store.notifications.some((entry) => entry.id === notification.id),
        false,
      );
    },
  );

  await t.test(
    "a local Git push produces a completion notification with its workspace target",
    async () => {
      const work = join(directory, "push-work");
      const remote = join(directory, "push-remote.git");
      fs.mkdirSync(work);
      execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
      const git = (...args) =>
        execFileSync("git", ["-C", work, ...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
      git("init", "-b", "main");
      git("config", "user.name", "Citropy Test");
      git("config", "user.email", "citropy-test@localhost.invalid");
      fs.writeFileSync(join(work, "sample.txt"), "Local notification test\n");
      git("add", "sample.txt");
      git("commit", "-m", "Initial fixture");
      git("remote", "add", "origin", remote);
      git("push", "-u", "origin", "main");
      fs.appendFileSync(join(work, "sample.txt"), "Push completion\n");
      git("commit", "-am", "Second fixture");
      const project = store.openProject(work);
      first.socket.send(
        JSON.stringify({
          t: "git.manage",
          requestId: "push-notice",
          projectId: project.id,
          operation: "push",
        }),
      );
      const response = await waitFor(() =>
        first.events.find(
          (event) =>
            event.t === "git.manage" && event.requestId === "push-notice",
        ),
      );
      assert.equal(response.error, undefined);
      const notification = await waitFor(() =>
        store.notifications.find(
          (entry) =>
            entry.title === "Push finished" &&
            entry.target.projectId === project.id,
        ),
      );
      assert.equal(notification.level, "success");
      assert.equal(notification.target.view, "git");
      assert.equal(
        execFileSync("git", ["--git-dir", remote, "rev-parse", "main"], {
          encoding: "utf8",
        }).trim(),
        git("rev-parse", "HEAD"),
      );
    },
  );

  await t.test(
    "browser connections from unrelated origins cannot control providers or GitHub",
    async () => {
      const socket = new WebSocket(url.replace("http", "ws") + "/socket", {
        origin: "https://unrelated.example",
      });
      sockets.push(socket);
      const error = await new Promise((resolve) =>
        socket.once("error", resolve),
      );
      assert.match(error.message, /401/);
      const local = new WebSocket(url.replace("http", "ws") + "/socket", {
        origin: url,
      });
      sockets.push(local);
      await once(local, "open");
      local.close();
    },
  );
});
