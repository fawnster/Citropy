import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dataDirectory = mkdtempSync(join(tmpdir(), "citropy-terminal-data-"));
process.env.CITROPY_DATA_DIR = dataDirectory;
const { openPanel, closePanel, panelList } = await import("../server/panels.ts");
const terminals = await import("../server/terminals.ts");
const { shellList, stopShell } = await import("../server/shells.ts");
const { waitForStoppedProcesses } = await import("../server/providers/process.ts");
const { bus } = await import("../server/bus.ts");

async function until(check) {
  for (let i = 0; i < 350; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Terminal state did not settle");
}

test("managed terminal stop kills its stubborn descendants and leaves another terminal running", { skip: process.platform !== "linux" }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "citropy-shell-terminal-"));
  const parent = join(directory, "parent.mjs");
  const child = join(directory, "child.mjs");
  const pids = join(directory, "pids.json");
  writeFileSync(child, "process.on('SIGTERM', () => {}); process.on('SIGHUP', () => {}); console.log('Child ready'); setInterval(() => {}, 1000);");
  writeFileSync(parent, `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'; const child = spawn(process.execPath, [${JSON.stringify(child)}], { stdio: 'inherit' }); writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, child.pid])); setInterval(() => {}, 1000);`);
  const first = openPanel("terminal-project", "terminal", "owner");
  const other = openPanel("terminal-project", "terminal", "other");
  t.after(async () => {
    await terminals.close(first.id);
    await terminals.close(other.id);
    await waitForStoppedProcesses();
    closePanel(first.id);
    closePanel(other.id);
    if (existsSync(pids)) for (const pid of JSON.parse(readFileSync(pids, "utf8"))) { try { process.kill(pid, "SIGKILL"); } catch {} }
    bus.emit({ t: "project.remove", id: "terminal-project" });
    rmSync(directory, { recursive: true, force: true });
  });
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(process.execPath)} ${quote(parent)}`;
  await terminals.open(first.id, directory, 80, 24, command);
  await terminals.open(other.id, directory, 80, 24, "cat");
  await until(() => existsSync(pids) && terminals.read(first.id).includes("Child ready"));
  const find = () => shellList().find(shell => shell.panelId === first.id);
  assert.equal(find().command, command);
  assert.equal(find().threadId, "owner");
  assert.equal(find().status, "running");
  await stopShell(find().id);
  assert.equal(find().status, "stopped");
  assert.equal(panelList().some(panel => panel.id === first.id), false);
  const alive = pid => {
    try { return !/^\d+ \(.+\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8")); }
    catch { return false; }
  };
  await until(() => JSON.parse(readFileSync(pids, "utf8")).every(pid => !alive(pid)));
  await terminals.write(other.id, "other-terminal-alive\n");
  await until(() => terminals.read(other.id).includes("other-terminal-alive"));
  assert.equal(shellList().find(shell => shell.panelId === other.id).status, "running");
  bus.emit({ t: "thread.remove", id: "other" });
  await waitForStoppedProcesses();
  assert.equal(panelList().some(panel => panel.id === other.id), false);
  assert.equal(shellList().some(shell => shell.panelId === other.id), false);
  await assert.rejects(terminals.write(other.id, "input"), /exited/);
});

test.after(async () => { await terminals.closeAll(); (await import("../server/event-journal.ts")).eventJournal.close(); rmSync(dataDirectory, { recursive: true, force: true }); });
