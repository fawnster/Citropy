import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import childProcess from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import { stopProcess, waitForStoppedProcesses } from "../server/providers/process.ts";

async function waitFor(check) {
  for (let index = 0; index < 200; index++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Lifecycle did not settle");
}

test("OpenCode owns and releases its process through startup failure, cancellation and stream closure", async (t) => {
  const directory = fs.mkdtempSync(`${os.tmpdir()}/citropy-provider-`);
  const originalHome = os.homedir;
  const originalSpawn = childProcess.spawn;
  const children = [];
  const sessions = [];
  let mode = "failure";
  const server = http.createServer((request, response) => {
    if (request.url === "/session") {
      response.writeHead(mode === "failure" ? 503 : 200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "session" }));
    } else if (request.url === "/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: {}\n\n");
      if (mode === "closed") response.end();
    } else response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  os.homedir = () => directory;
  childProcess.spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.signals = [];
    child.kill = (signal) => {
      child.signals.push(signal);
      queueMicrotask(() => {
        child.signalCode = signal;
        child.emit("exit", null, signal);
        child.stdout.end();
        child.stderr.end();
      });
      return true;
    };
    children.push(child);
    queueMicrotask(() => {
      if (child.signalCode === null) child.stdout.write(`http://127.0.0.1:${server.address().port}\n`);
    });
    return child;
  };
  syncBuiltinESMExports();
  t.after(async () => {
    for (const session of sessions) session.dispose();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    childProcess.spawn = originalSpawn;
    os.homedir = originalHome;
    syncBuiltinESMExports();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const { opencodeProvider } = await import("../server/providers/opencode.ts");
  const events = [];
  const start = () => {
    const session = opencodeProvider.start({ threadId: "same-thread", cwd: directory, permissionMode: "manual", emit: (event) => events.push(event) });
    sessions.push(session);
    return session;
  };

  start();
  await waitFor(() => events.some((event) => event.type === "exit"));
  assert.deepEqual(children[0].signals, ["SIGTERM"]);
  assert.match(events.find((event) => event.type === "notice").text, /503/);

  mode = "ready";
  events.length = 0;
  const recovered = start();
  await waitFor(() => events.some((event) => event.type === "session"));
  assert.equal(children.length, 2);
  recovered.dispose();
  recovered.dispose();
  assert.deepEqual(children[1].signals, ["SIGTERM"]);

  events.length = 0;
  const cancelled = start();
  cancelled.dispose();
  await waitFor(() => children[2].signalCode !== null);
  assert.deepEqual(children[2].signals, ["SIGTERM"]);
  assert.equal(events.length, 0);

  mode = "closed";
  start();
  await waitFor(() => events.some((event) => event.type === "exit"));
  assert.deepEqual(children[3].signals, ["SIGTERM"]);
});

test("provider shutdown clears its deadline on exit and escalates only for a stuck process", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = new EventEmitter();
  const signals = [];
  child.kill = (signal) => signals.push(signal);
  stopProcess(child);
  child.exitCode = 0;
  child.emit("exit", 0);
  t.mock.timers.tick(3000);
  assert.deepEqual(signals, ["SIGTERM"]);
  stopProcess(child);
  assert.deepEqual(signals, ["SIGTERM"]);
  const stuck = new EventEmitter();
  stuck.kill = (signal) => signals.push(signal);
  stopProcess(stuck);
  stopProcess(stuck);
  let finished = false;
  const shutdown = waitForStoppedProcesses().then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  t.mock.timers.tick(2000);
  assert.deepEqual(signals, ["SIGTERM", "SIGTERM", "SIGKILL"]);
  stuck.emit("exit", null, "SIGKILL");
  await shutdown;
  assert.equal(finished, true);
  assert.equal(stuck.listenerCount("exit"), 0);
  assert.equal(stuck.listenerCount("close"), 0);
});

test("shutdown waits for a real process that ignores graceful termination", { timeout: 10_000 }, async (t) => {
  const child = childProcess.spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);"], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => { if (child.signalCode === null) child.kill("SIGKILL"); });
  await once(child.stdout, "data");
  stopProcess(child);
  await waitForStoppedProcesses();
  assert.equal(child.signalCode, "SIGKILL");
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
});
