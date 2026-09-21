import assert from "node:assert/strict";
import { test } from "node:test";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("providers surface stray non-JSON stdout as warnings", async (t) => {
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
    children.push(child);
    return child;
  };
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  });

  const { claudeProvider } = await import("../server/providers/claude.ts");
  const { codexProvider } = await import("../server/providers/codex.ts");
  const options = { threadId: "fixture", cwd: process.cwd(), permissionMode: "manual" };

  const claudeEvents = [];
  claudeProvider.start({ ...options, emit: (event) => claudeEvents.push(event) });
  const claude = children.at(-1);
  claude.stdout.write("Deprecation warning: --foo is deprecated\n");
  await tick();
  assert.ok(claudeEvents.some((event) => event.type === "notice" && event.level === "warn" && /Deprecation warning/.test(event.text)));

  const codexEvents = [];
  codexProvider.start({ ...options, emit: (event) => codexEvents.push(event) });
  const codex = children.at(-1);
  codex.stdout.write("codex: noisy warning\n");
  await tick();
  assert.ok(codexEvents.some((event) => event.type === "notice" && event.level === "warn" && /noisy warning/.test(event.text)));
});
