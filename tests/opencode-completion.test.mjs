import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import childProcess from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";

async function until(check) {
  for (let index = 0; index < 200; index++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("OpenCode completion did not settle");
}

test("OpenCode completes replies from its event stream and drains queued follow-ups", async (t) => {
  const directory = fs.mkdtempSync(`${os.tmpdir()}/citropy-completion-`);
  const originalHome = os.homedir;
  const originalSpawn = childProcess.spawn;
  const prompts = [];
  let stream;
  const server = http.createServer((request, response) => {
    request.resume();
    response.setHeader("content-type", "application/json");
    if (request.url === "/session") response.end(JSON.stringify({ id: "session" }));
    else if (request.url === "/event") {
      stream = response;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": ready\n\n");
    } else if (request.url === "/session/session/message") prompts.push(response);
    else response.end("true");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
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
    await new Promise(resolve => server.close(resolve));
    childProcess.spawn = originalSpawn;
    os.homedir = originalHome;
    syncBuiltinESMExports();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const project = store.openProject(directory);
  const thread = store.createThread({ projectId: project.id, provider: "opencode", title: "Completion check", permissionMode: "plan" });
  const runtime = runtimeFor(thread.id);
  const notify = (type, properties = {}) => stream.write(`data: ${JSON.stringify({ type, properties: { sessionID: "session", ...properties } })}\n\n`);
  const status = type => notify("session.status", { status: { type } });
  const part = (id, extra) => notify("message.part.updated", { part: { id, sessionID: "session", ...extra } });

  await runtime.send("Check a long-running command");
  await until(() => prompts.length === 1 && stream);
  status("busy");
  part("command", { type: "tool", callID: "command", tool: "bash", state: { status: "running", input: { command: "long-check" } } });
  await until(() => thread.messages.some(message => message.parts.some(part => part.kind === "tool")));
  await runtime.send("Check the result too");
  assert.equal(thread.queue.length, 1);
  notify("session.status", { sessionID: "child", status: { type: "idle" } });
  notify("message.updated", { info: { id: "step", role: "assistant", time: { completed: Date.now() }, finish: "tool-calls" } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(thread.running, true);
  assert.equal(thread.queue.length, 1);
  part("command", { type: "tool", callID: "command", tool: "bash", state: { status: "completed", input: { command: "long-check" }, output: "Passed" } });
  part("command", { type: "tool", callID: "command", tool: "bash", state: { status: "completed", input: { command: "long-check" }, output: "Passed" } });
  part("answer", { type: "text", text: "The long-running command completed." });
  notify("message.updated", { info: { id: "answer-message", role: "assistant", time: { completed: Date.now() }, finish: "stop" } });
  status("idle");
  notify("session.idle");
  await until(() => prompts.length === 2);
  assert.equal(thread.usage.turns, 1);
  assert.equal(thread.queue.length, 0);
  assert.equal(thread.running, true);
  assert.equal(thread.error, undefined);
  const reply = thread.messages.find(message => message.role === "assistant");
  assert.equal(reply.parts.find(part => part.kind === "tool").status, "ok");
  assert.equal(reply.parts.filter(part => part.kind === "tool").length, 1);
  assert.equal(reply.parts.find(part => part.kind === "text").text, "The long-running command completed.");

  prompts[0].destroy();
  status("busy");
  part("follow-up", { type: "text", text: "The result is correct." });
  await until(() => thread.messages.at(-1).parts.some(part => part.text === "The result is correct."));
  prompts[1].end("{}");
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(thread.running, true);
  assert.equal(thread.error, undefined);
  assert.equal(thread.usage.turns, 1);
  status("idle");
  await until(() => !thread.running);
  assert.equal(thread.status, "idle");
  assert.equal(thread.usage.turns, 2);
  part("command", { type: "tool", callID: "command", tool: "bash", state: { status: "completed", input: { command: "long-check" }, output: "Passed" } });
  notify("session.idle");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(thread.running, false);
  assert.equal(thread.usage.turns, 2);
  assert.equal(thread.messages.filter(message => message.role === "assistant").length, 2);
});
