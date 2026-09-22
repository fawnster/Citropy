import assert from "node:assert/strict";
import { test } from "node:test";
import { fork } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packagedBackend } from "../desktop/backend.mjs";

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test("the server exits cleanly when the parent sends the shutdown message over IPC", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-shutdown-ipc-"));
  const port = await freePort();
  const child = fork(fileURLToPath(new URL("../server/main.ts", import.meta.url)), {
    execArgv: ["--experimental-strip-types"],
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, CITROPY_PORT: String(port), CITROPY_DATA_DIR: join(directory, "data"), CITROPY_HOST: "127.0.0.1" },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  });
  child.stderr.resume();
  let readyTimer;
  try {
    await Promise.race([
      once(child, "message"),
      new Promise((_, reject) => { readyTimer = setTimeout(() => reject(new Error("The server never became ready.")), 30_000); }),
    ]);
  } finally {
    clearTimeout(readyTimer);
  }
  assert.equal(child.connected, true);
  child.send({ t: "shutdown" });
  const [code, signal] = await once(child, "exit");
  assert.equal(signal, null);
  assert.equal(code, 0);
});

test("stopping the packaged backend resolves without a last-resort signal", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-shutdown-backend-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const diagnostics = [];
  const backend = packagedBackend({ ...process.env, CITROPY_PORT: String(await freePort()), CITROPY_DATA_DIR: join(directory, "data"), CITROPY_HOST: "127.0.0.1" }, (event, details) => diagnostics.push({ event, ...details }));
  await backend.start();
  await backend.stop();
  assert.deepEqual(diagnostics.map(entry => entry.event), ["backend.started", "backend.ready", "backend.stop-requested", "backend.exited"]);
  assert.equal(diagnostics.at(-1).code, 0);
  assert.equal(diagnostics.at(-1).signal, null);
  assert.ok(diagnostics.every(entry => entry.childPid === diagnostics[0].childPid));
});
