import assert from "node:assert/strict";
import { test } from "node:test";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const until = async (check, message) => {
  for (let index = 0; index < 500; index++) {
    if (check()) return;
    await tick();
  }
  throw new Error(`Timed out waiting for ${message}`);
};

test("interrupting a provider keeps its allow-always approvals", async (t) => {
  const directory = fs.mkdtempSync(join(os.tmpdir(), "citropy-approval-"));
  process.env.CITROPY_DATA_DIR = join(directory, "data");
  const originalSpawn = childProcess.spawn;
  const children = [];
  childProcess.spawn = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => true;
    child.messages = [];
    child.stdin.on("data", (data) => child.messages.push(JSON.parse(String(data))));
    child.receive = (value) => child.stdout.write(`${JSON.stringify(value)}\n`);
    children.push(child);
    return child;
  };
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const { codexProvider } = await import("../server/providers/codex.ts");
  const { pendingRequests, answer, cancelThread, ask } = await import("../server/permissions.ts");

  const keep = ask("keep-thread", "Bash", { command: "ls" });
  const keepRequest = pendingRequests().find((request) => request.threadId === "keep-thread");
  answer(keepRequest.id, "allow_always");
  assert.equal(await keep, "allow_always");
  cancelThread("keep-thread", false);
  assert.equal(await ask("keep-thread", "Bash", {}), "allow");
  cancelThread("keep-thread");
  const forgotten = ask("keep-thread", "Bash", {});
  assert.ok(pendingRequests().some((request) => request.threadId === "keep-thread"));
  answer(pendingRequests().find((request) => request.threadId === "keep-thread").id, "deny");
  assert.equal(await forgotten, "deny");

  const events = [];
  const session = codexProvider.start({ threadId: "approval-thread", cwd: directory, permissionMode: "manual", emit: (event) => events.push(event) });
  const child = children.at(-1);
  const reply = (method, result) => {
    const request = child.messages.findLast((message) => message.method === method);
    assert.ok(request, method);
    child.receive({ id: request.id, result });
  };
  session.send("hello");
  await until(() => child.messages.some((message) => message.method === "initialize"), "initialize");
  reply("initialize", {});
  await until(() => child.messages.some((message) => message.method === "thread/start"), "thread/start");
  reply("thread/start", { thread: { id: "native" } });
  await until(() => child.messages.some((message) => message.method === "turn/start"), "turn/start");
  child.receive({ id: "appr-1", method: "item/commandExecution/requestApproval", params: { threadId: "native", itemId: "tool", command: "touch x" } });
  await until(() => pendingRequests().some((request) => request.threadId === "approval-thread"), "the first approval");
  answer(pendingRequests().find((request) => request.threadId === "approval-thread").id, "allow_always");
  await until(() => child.messages.some((message) => message.id === "appr-1" && message.result), "the first approval reply");
  assert.deepEqual(child.messages.find((message) => message.id === "appr-1").result, { decision: "accept" });
  session.interrupt();
  child.receive({ id: "appr-2", method: "item/commandExecution/requestApproval", params: { threadId: "native", itemId: "tool2", command: "touch y" } });
  await until(() => child.messages.some((message) => message.id === "appr-2" && message.result), "the second approval reply");
  assert.deepEqual(child.messages.find((message) => message.id === "appr-2").result, { decision: "accept" });
  assert.equal(pendingRequests().some((request) => request.threadId === "approval-thread"), false);
  session.dispose();
});
