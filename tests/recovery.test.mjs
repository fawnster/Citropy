import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter, once } from "node:events";
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
        async stopShell(taskId) { session.stoppedShell = taskId; },
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

  await t.test("saved provider plans recover their text and statuses on reload", () => {
    const entry = store.createThread({ projectId: project.id, provider: "opencode", title: "Saved plan", permissionMode: "plan" });
    store.addMessage(entry.id, { id: "saved-plan-message", role: "assistant", ts: 1, parts: [
      { id: "saved-plan", kind: "todo", items: [
        { content: "Inspect the service", status: "completed", priority: "high" },
        { content: "Verify the result", status: "in_progress", priority: "high" },
        { content: "Replace the service", status: "cancelled" },
        { content: " ", status: "pending" },
      ] },
    ] });
    store.flush();
    const loaded = new Store().threads.get(entry.id);
    assert.deepEqual(loaded.messages[0].parts[0].items, [
      { text: "Inspect the service", status: "completed" },
      { text: "Verify the result", status: "in_progress" },
      { text: "Replace the service", status: "cancelled" },
    ]);
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
  await t.test("browser panels load the chosen link and reject non-web destinations before creating a panel", async test => {
    const { attachDesktop } = await import("../server/desktop.ts");
    const { closeBrowser } = await import("../server/browser.ts");
    const { panelList, closePanel } = await import("../server/panels.ts");
    const calls = [];
    const bridge = Object.assign(new EventEmitter(), {
      OPEN: 1, readyState: 1,
      send(raw) {
        const request = JSON.parse(raw);
        calls.push(request);
        queueMicrotask(() => bridge.emit("message", JSON.stringify({ id: request.id, result: request.method === "browser.open" ? { ...request.params, title: "Linked page" } : null })));
      },
      close() { bridge.emit("close"); },
    });
    attachDesktop(bridge);
    test.after(async () => {
      await closeBrowser("linked-browser");
      closePanel("linked-browser");
      bridge.close();
    });
    const destination = "https://example.test/guide?q=one#section";
    first.socket.send(JSON.stringify({ t: "panel.open", id: "linked-browser", kind: "browser", projectId: project.id, threadId: thread.id, url: destination }));
    const opened = await waitFor(() => first.events.find(event => event.t === "browser.state" && event.browser.id === "linked-browser"));
    assert.equal(opened.browser.url, destination);
    assert.equal(opened.browser.threadId, thread.id);
    assert.equal(calls.find(request => request.method === "browser.open").params.url, destination);
    const count = calls.length;
    for (const [kind, url] of [["browser", "file:///tmp/private.txt"], ["browser", "javascript:alert(1)"], ["browser", "not a url"], ["terminal", destination]]) {
      const start = first.events.length;
      first.socket.send(JSON.stringify({ t: "panel.open", id: "invalid-link", kind, projectId: project.id, url }));
      await waitFor(() => first.events.slice(start).some(event => event.t === "toast" && event.level === "error"));
      assert.equal(panelList().some(panel => panel.id === "invalid-link"), false);
    }
    assert.equal(calls.length, count);
  });
  await t.test("a folder selected by the desktop opens without launching another picker", async () => {
    const selected = join(directory, "Selected folder # ✓");
    const bin = join(directory, "picker-bin");
    const marker = join(directory, "picker-opened");
    fs.mkdirSync(selected);
    fs.mkdirSync(bin);
    fs.writeFileSync(join(bin, "kdialog"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'opened');process.exit(1);\n`, { mode: 0o700 });
    const previousPath = process.env.PATH;
    const projectCount = store.projects.size;
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      let selectedId;
      for (const path of [selected, `${selected}/`, join(directory, "missing-folder")]) {
        const start = first.events.length;
        first.socket.send(JSON.stringify({ t: "project.choose", path }));
        const result = await waitFor(() => first.events.slice(start).find(event => event.t === "project.chosen"));
        if (path.endsWith("missing-folder")) {
          assert.equal(result.projectId, null);
          assert.match(result.error, /ENOENT/);
        } else {
          assert.ok(result.projectId, JSON.stringify(result));
          assert.equal(store.projects.get(result.projectId).path, selected);
          if (selectedId) assert.equal(result.projectId, selectedId);
          selectedId = result.projectId;
        }
      }
      assert.equal(store.projects.size, projectCount + 1);
      assert.equal(fs.existsSync(marker), false, "Opening a selected folder must not launch the system picker again.");
      store.closeProject(selectedId);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
  await t.test("running shells survive unloaded history and background replies, with owned stop controls", async (subtest) => {
    const previousSessions = sessions.length;
    const { shellList } = await import("../server/shells.ts");
    const entry = store.createThread({ projectId: project.id, provider: "claude", title: "Background server", permissionMode: "manual" });
    const other = store.createThread({ projectId: project.id, provider: "claude", title: "Another task", permissionMode: "manual" });
    subtest.after(() => {
      disposeRuntime(entry.id);
      disposeRuntime(other.id);
      store.removeThread(entry.id);
      store.removeThread(other.id);
      sessions.splice(previousSessions);
    });
    await runtimeFor(entry.id).send("Start a server");
    const session = sessions.at(-1);
    await runtimeFor(other.id).send("Unrelated work");
    const independent = sessions.at(-1);
    const emit = event => session.options.emit(event);
    const id = `${entry.id}:server`;
    const find = () => shellList().find(shell => shell.id === id);
    emit({ type: "tool.start", callId: "server", name: "Bash", input: { command: "npm run dev" } });
    assert.equal(find().stopMode, "task");
    emit({ type: "shell.background", callId: "server", taskId: "native-server" });
    emit({ type: "tool.output", callId: "server", output: "Server ready" });
    emit({ type: "tool.end", callId: "server", ok: true, output: "" });
    assert.equal(find().output, "Server ready");
    emit({ type: "turn.end" });
    assert.equal(entry.running, false);
    assert.equal(find().status, "running");
    assert.equal(find().stopMode, "shell");
    assert.equal(runtimeFor(entry.id).busy, true);
    const { reloadProviderSessions } = await import("../server/runtime.ts");
    reloadProviderSessions(new Set(["claude"]));
    assert.equal(session.disposed, false);
    const count = entry.messages.length;
    emit({ type: "tool.output", callId: "server", output: "\nGET / 200", append: true });
    assert.equal(entry.messages.length, count);
    const snapshot = (await connect()).events.find(event => event.t === "hello").snapshot;
    assert.match(snapshot.shells.find(shell => shell.id === id).output, /GET \/ 200/);
    const rejected = await fetch(`${url}/api/shells/stop`, { method: "POST", headers: { "content-type": "application/json", origin: "https://unrelated.invalid" }, body: JSON.stringify({ id }) });
    assert.equal(rejected.status, 403);
    assert.equal(session.stoppedShell, undefined);
    const stopped = await fetch(`${url}/api/shells/stop`, { method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ id }) });
    assert.equal(stopped.status, 200);
    assert.equal(session.stoppedShell, "native-server");
    assert.equal(find().status, "stopped");
    assert.equal(session.disposed, false);
    assert.equal(independent.disposed, false);
    assert.equal(runtimeFor(entry.id).busy, false);
    await runtimeFor(entry.id).send("Run another shell");
    emit({ type: "tool.start", callId: "foreground", name: "Bash", input: { command: "long test" } });
    const fallback = await fetch(`${url}/api/shells/stop`, { method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ id: `${entry.id}:foreground` }) });
    assert.equal(fallback.status, 200);
    assert.equal(session.disposed, true);
    assert.equal(independent.disposed, false);
    assert.equal(entry.status, "stopped");
    disposeRuntime(other.id);
    store.removeThread(entry.id);
    store.removeThread(other.id);
    assert.equal(find(), undefined);
  });
  await t.test("tool results with images store the picture beside the conversation", async (subtest) => {
    const previousSessions = sessions.length;
    const entry = store.createThread({ projectId: project.id, provider: "claude", title: "Screenshots", permissionMode: "manual" });
    subtest.after(() => { disposeRuntime(entry.id); store.removeThread(entry.id); sessions.splice(previousSessions); });
    await runtimeFor(entry.id).send("Look at the screen");
    const session = sessions.at(-1);
    const emit = event => session.options.emit(event);
    emit({ type: "tool.start", callId: "shot", name: "mcp__citropy__computer_screenshot", input: {} });
    emit({ type: "tool.end", callId: "shot", ok: true, output: "Captured", images: [{ mime: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64") }] });
    const part = await waitFor(() => entry.messages.flatMap(message => message.parts).find(part => part.kind === "tool" && part.callId === "shot" && part.images?.length));
    assert.equal(part.images.length, 1);
    assert.equal(part.images[0].mime, "image/png");
    assert.equal(fs.existsSync(join(directory, ".citropy", "tool-images", entry.id, `${part.images[0].id}.png`)), true);
    assert.deepEqual(fs.readFileSync(join(directory, ".citropy", "tool-images", entry.id, `${part.images[0].id}.png`)), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const toolPart = callId => entry.messages.flatMap(message => message.parts).find(part => part.kind === "tool" && part.callId === callId);
    emit({ type: "tool.start", callId: "read", name: "Read", input: { file_path: join(directory, "cat.jpg") } });
    assert.deepEqual(toolPart("read").imageFiles, [{ path: join(directory, "cat.jpg"), label: "cat.jpg" }]);
    assert.equal(toolPart("read").images, undefined);
    emit({ type: "tool.end", callId: "read", ok: true, output: "" });
    emit({ type: "tool.start", callId: "outside", name: "Read", input: { file_path: "/etc/passwd.png" } });
    assert.deepEqual(toolPart("outside").imageFiles, [{ path: "/etc/passwd.png", label: "passwd.png" }]);
    emit({ type: "tool.end", callId: "outside", ok: true, output: "" });
    emit({ type: "turn.end" });
    store.removeThread(entry.id);
    assert.equal(fs.existsSync(join(directory, ".citropy", "tool-images", entry.id)), false);
  });
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

  await t.test("empty threads can change provider while existing sessions and rejected changes stay intact", async () => {
    const fresh = store.createThread({ projectId: project.id, provider: "claude", model: "test", title: "Provider selection", permissionMode: "manual" });
    store.setUsage(fresh.id, { ...fresh.usage, contextMax: 200000 });
    first.socket.send(JSON.stringify({ t: "thread.config", id: fresh.id, provider: "codex", model: "test", effort: "low", requestId: "switch-provider" }));
    await waitFor(() => first.events.some(event => event.t === "thread.accepted" && event.requestId === "switch-provider"));
    assert.equal(fresh.provider, "codex");
    assert.equal(fresh.effort, "low");
    assert.equal(fresh.usage.contextMax, 0);
    store.flush();
    assert.equal(new Store().threads.get(fresh.id).provider, "codex");
    for (const [id, patch] of [["session", { externalId: "saved-session" }], ["running", { running: true }], ["queue", { queue: [{ id: "queued", text: "Waiting", createdAt: 1 }] }]]) {
      store.patchThread(fresh.id, patch);
      first.socket.send(JSON.stringify({ t: "thread.config", id: fresh.id, provider: "claude", model: "test", requestId: `blocked-${id}` }));
      await waitFor(() => first.events.some(event => event.t === "request.error" && event.requestId === `blocked-${id}`));
      assert.equal(fresh.provider, "codex");
      store.patchThread(fresh.id, { externalId: undefined, running: false, queue: [] });
    }
    store.addMessage(fresh.id, { id: "provider-message", role: "user", ts: 1, parts: [{ id: "provider-text", kind: "text", text: "Keep this history" }] });
    first.socket.send(JSON.stringify({ t: "thread.config", id: fresh.id, provider: "claude", model: "test", requestId: "blocked-history" }));
    await waitFor(() => first.events.some(event => event.t === "request.error" && event.requestId === "blocked-history"));
    assert.equal(fresh.provider, "codex");
    assert.equal(fresh.messages[0].parts[0].text, "Keep this history");
    store.removeThread(fresh.id);
  });

  await t.test("changing access preserves inactive task status and applies to the next session", async (subtest) => {
    const previousSessions = sessions.length;
    const created = [];
    subtest.after(() => {
      for (const id of created) { disposeRuntime(id); store.removeThread(id); }
      sessions.splice(previousSessions);
    });
    for (const provider of ["claude", "codex", "opencode"]) {
      for (const status of ["idle", "stopped", "error"]) {
        const entry = store.createThread({ projectId: project.id, provider, model: "test", title: `Access ${provider} ${status}`, permissionMode: "manual" });
        created.push(entry.id);
        const runtime = runtimeFor(entry.id);
        await runtime.send("First message");
        const old = sessions.at(-1);
        old.options.emit({ type: "session", externalId: `native-${entry.id}` });
        if (status === "stopped") runtime.stop();
        else old.options.emit({ type: "turn.end", ...(status === "error" ? { error: "Previous failure" } : {}) });
        assert.equal(entry.status, status);
        await waitFor(() => first.events.some(event => event.t === "thread.upsert" && event.thread.id === entry.id && event.thread.externalId === `native-${entry.id}` && event.thread.status === status && !event.thread.running));
        const offset = first.events.length;
        const requestId = `access-${entry.id}`;
        first.socket.send(JSON.stringify({ t: "thread.config", id: entry.id, permissionMode: "bypass", requestId }));
        await waitFor(() => first.events.some(event => event.t === "thread.accepted" && event.requestId === requestId));
        assert.equal(entry.permissionMode, "bypass");
        assert.equal(entry.status, status);
        assert.equal(entry.running, false);
        assert.equal(old.disposed, true);
        assert.ok(first.events.slice(offset).filter(event => event.t === "thread.upsert" && event.thread.id === entry.id).every(event => event.thread.status === status));
        const messageCount = entry.messages.length;
        old.options.emit({ type: "exit", code: 1 });
        assert.equal(entry.status, status);
        assert.equal(entry.messages.length, messageCount);
        await runtimeFor(entry.id).send("Continue with the new access");
        const next = sessions.at(-1);
        assert.notEqual(next, old);
        assert.equal(next.options.permissionMode, "bypass");
        assert.equal(next.options.externalId, `native-${entry.id}`);
        const rejected = `busy-${entry.id}`;
        first.socket.send(JSON.stringify({ t: "thread.config", id: entry.id, permissionMode: "manual", requestId: rejected }));
        await waitFor(() => first.events.some(event => event.t === "request.error" && event.requestId === rejected));
        assert.equal(entry.permissionMode, "bypass");
        assert.equal(entry.running, true);
        assert.equal(next.disposed, false);
        runtimeFor(entry.id).stop();
        assert.equal(entry.status, "stopped");
      }
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
