import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import childProcess from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";

async function until(check, message) {
  for (let index = 0; index < 400; index++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

test("OpenCode fails the turn instead of buffering an unbounded event stream", async (t) => {
  const directory = fs.mkdtempSync(`${os.tmpdir()}/citropy-stream-cap-`);
  const originalHome = os.homedir;
  const originalSpawn = childProcess.spawn;
  let stream;
  const server = http.createServer((request, response) => {
    request.resume();
    response.setHeader("content-type", "application/json");
    if (request.url === "/session") response.end(JSON.stringify({ id: "session" }));
    else if (request.url === "/event") {
      stream = response;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": ready\n\n");
    } else response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  os.homedir = () => directory;
  childProcess.spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit("exit", 0)); return true; };
    queueMicrotask(() => child.stdout.write(`http://127.0.0.1:${server.address().port}\n`));
    return child;
  };
  syncBuiltinESMExports();
  const { store } = await import("../server/store.ts");
  const { runtimeFor, disposeAll } = await import("../server/runtime.ts");
  t.after(async () => {
    disposeAll();
    store.flush();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    childProcess.spawn = originalSpawn;
    os.homedir = originalHome;
    syncBuiltinESMExports();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const project = store.openProject(directory);
  const thread = store.createThread({ projectId: project.id, provider: "opencode", title: "Stream cap", permissionMode: "plan" });
  const runtime = runtimeFor(thread.id);
  await runtime.send("Check a long-running command");
  await until(() => stream, "the event stream");

  stream.write("x".repeat(9 * 1024 * 1024));
  await until(() => thread.messages.some((message) => message.parts.some((part) => part.kind === "notice" && /8 MB/.test(part.text ?? ""))), "the overflow notice");
  await until(() => !thread.running, "the turn to fail");
  assert.match(thread.error ?? "", /8 MB/);
});
