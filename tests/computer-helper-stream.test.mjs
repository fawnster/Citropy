import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import childProcess from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("computer helper replies preserve UTF-8 across chunk boundaries", async t => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-computer-stream-"));
  const originalSpawn = childProcess.spawn;
  let stopComputer;
  t.after(async () => {
    await stopComputer?.();
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  });
  const electron = join(directory, "node_modules/electron");
  await mkdir(electron, { recursive: true });
  await writeFile(join(electron, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
  await writeFile(join(electron, "index.js"), "export const globalShortcut = { register: () => true, isRegistered: () => false, unregister() {} };\n");
  await writeFile(join(directory, "computer-indicator.mjs"), "export async function openComputerIndicator() { return { close() {}, update() {} }; }\n");
  await copyFile(new URL("../desktop/computer.mjs", import.meta.url), join(directory, "computer.mjs"));

  const helper = new EventEmitter();
  helper.stdin = new PassThrough();
  helper.stdout = new PassThrough();
  helper.stderr = new PassThrough();
  const name = "Écran intégré 🖥 外接";
  const failure = "Écran déconnecté 🖥 外接";
  const emit = message => {
    const bytes = Buffer.from(`${JSON.stringify(message)}\n`);
    for (let index = 0; index < bytes.length; index++) helper.stdout.write(bytes.subarray(index, index + 1));
  };
  helper.stdin.on("data", data => {
    const { id, method } = JSON.parse(data);
    queueMicrotask(() => emit(method === "start"
      ? { id, result: { displays: [{ id: "1", name, width: 1920, height: 1080 }] } }
      : { id, error: failure }));
  });
  childProcess.spawn = () => helper;
  syncBuiltinESMExports();
  const computer = await import(pathToFileURL(join(directory, "computer.mjs")));
  stopComputer = computer.stopComputer;
  const events = [];
  computer.connectComputerEvents(event => events.push(event));
  assert.equal((await computer.computerRequest("computer.start")).displays[0].name, name);
  await assert.rejects(computer.computerRequest("computer.screenshot"), error => error.message === failure);
  emit({ event: "closed", reason: failure, error: true });
  assert.deepEqual(events, [{ t: "computer.stopped", reason: failure, error: true }]);
});
