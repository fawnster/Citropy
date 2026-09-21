import assert from "node:assert/strict";
import { test } from "node:test";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";

const tick = () => new Promise((resolve) => setImmediate(resolve));

const until = async (check, message) => {
  for (let index = 0; index < 500; index++) {
    if (check()) return;
    await tick();
  }
  throw new Error(`Timed out waiting for ${message}`);
};

test("Codex keeps its session alive when turn requests time out", async (t) => {
  const originalSpawn = childProcess.spawn;
  const children = [];
  childProcess.spawn = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    child.messages = [];
    child.stdin.on("data", (data) => child.messages.push(JSON.parse(String(data))));
    child.receive = (value) => child.stdout.write(`${JSON.stringify(value)}\n`);
    child.kill = () => { child.killed = true; return true; };
    children.push(child);
    return child;
  };
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const { codexProvider } = await import("../server/providers/codex.ts");
  const options = { threadId: "fixture", cwd: process.cwd(), permissionMode: "manual" };
  const reply = (child, method, result) => {
    const request = child.messages.findLast((message) => message.method === method);
    assert.ok(request, method);
    child.receive({ id: request.id, result });
  };

  await t.test("a slow turn/start ends the turn without killing the app-server", async () => {
    const events = [];
    const session = codexProvider.start({ ...options, emit: (event) => events.push(event) });
    const child = children.at(-1);
    session.send("hello");
    await until(() => child.messages.some((message) => message.method === "initialize"), "initialize");
    reply(child, "initialize", {});
    await until(() => child.messages.some((message) => message.method === "thread/start"), "thread/start");
    reply(child, "thread/start", { thread: { id: "native-thread" } });
    await until(() => child.messages.some((message) => message.method === "turn/start"), "turn/start");
    t.mock.timers.tick(30_000);
    await tick();
    assert.ok(events.some((event) => event.type === "turn.end" && /turn\/start timed out/.test(event.error ?? "")));
    assert.equal(events.some((event) => event.type === "exit"), false);
    assert.equal(child.killed, false);
    session.dispose();
  });

  await t.test("a slow turn/steer rejects without killing the app-server", async () => {
    const events = [];
    const session = codexProvider.start({ ...options, emit: (event) => events.push(event) });
    const child = children.at(-1);
    session.send("hello");
    await until(() => child.messages.some((message) => message.method === "initialize"), "initialize");
    reply(child, "initialize", {});
    await until(() => child.messages.some((message) => message.method === "thread/start"), "thread/start");
    reply(child, "thread/start", { thread: { id: "native-thread" } });
    await until(() => child.messages.some((message) => message.method === "turn/start"), "turn/start");
    reply(child, "turn/start", { turn: { id: "turn-1" } });
    await tick();
    const steering = session.steer("more");
    await until(() => child.messages.some((message) => message.method === "turn/steer"), "turn/steer");
    t.mock.timers.tick(30_000);
    await assert.rejects(steering, /turn\/steer timed out/);
    assert.equal(events.some((event) => event.type === "exit"), false);
    assert.equal(child.killed, false);
    session.dispose();
  });
});
