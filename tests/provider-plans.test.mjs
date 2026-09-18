import assert from "node:assert/strict";
import { test } from "node:test";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";

test("Claude and Codex convert native plan updates into readable steps", async (t) => {
  const originalSpawn = childProcess.spawn;
  const children = [];
  const sessions = [];
  childProcess.spawn = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.receive = value => child.stdout.write(`${JSON.stringify(value)}\n`);
    child.stdin.on("data", data => {
      const request = JSON.parse(String(data));
      if (request.id !== undefined) queueMicrotask(() => child.receive({ id: request.id, result: { thread: { id: "native-thread" } } }));
    });
    child.kill = signal => {
      child.signalCode = signal;
      queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    };
    children.push(child);
    return child;
  };
  syncBuiltinESMExports();
  t.after(() => {
    sessions.forEach(session => session.dispose());
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  });
  const { claudeProvider } = await import("../server/providers/claude.ts");
  const { codexProvider } = await import("../server/providers/codex.ts");
  const options = { threadId: "fixture", cwd: process.cwd(), permissionMode: "plan" };

  await t.test("Claude TodoWrite includes content and supports clearing the list", () => {
    const events = [];
    sessions.push(claudeProvider.start({ ...options, emit: event => events.push(event) }));
    const update = todos => children.at(-1).receive({ type: "assistant", message: { content: [
      { type: "tool_use", id: "plan", name: "TodoWrite", input: { todos } },
    ] } });
    update([
      { content: "Inspect the service", activeForm: "Inspecting the service", status: "in_progress" },
      { content: "Verify the result", activeForm: "Verifying the result", status: "pending" },
    ]);
    assert.deepEqual(events.findLast(event => event.type === "todos").items, [
      { text: "Inspect the service", status: "in_progress" },
      { text: "Verify the result", status: "pending" },
    ]);
    update([]);
    assert.deepEqual(events.findLast(event => event.type === "todos").items, []);
  });

  await t.test("Codex preserves step text and native status changes", async () => {
    const events = [];
    sessions.push(codexProvider.start({ ...options, emit: event => events.push(event) }));
    await new Promise(resolve => setImmediate(resolve));
    children.at(-1).receive({ method: "turn/plan/updated", params: { threadId: "native-thread", plan: [
      { step: "Inspect the service", status: "completed" },
      { step: "Verify the result", status: "inProgress" },
    ] } });
    assert.deepEqual(events.findLast(event => event.type === "todos").items, [
      { text: "Inspect the service", status: "completed" },
      { text: "Verify the result", status: "in_progress" },
    ]);
    children.at(-1).receive({ method: "turn/plan/updated", params: { threadId: "native-thread", plan: [] } });
    assert.deepEqual(events.findLast(event => event.type === "todos").items, []);
  });
});
