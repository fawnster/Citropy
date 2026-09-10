import assert from "node:assert/strict";
import { test } from "node:test";
import { promisify } from "node:util";
import { syncBuiltinESMExports } from "node:module";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";

test("Git refreshes coalesce overlapping reads and refresh again after a concurrent change", async (t) => {
  const directory = fs.mkdtempSync(`${os.tmpdir()}/citropy-git-monitor-`);
  const originalHome = os.homedir;
  const originalExecFile = childProcess.execFile;
  const waiting = [];
  let scans = 0;
  let changed = false;
  childProcess.execFile = () => { throw new Error("Use the async Git interface"); };
  childProcess.execFile[promisify.custom] = async (_command, args) => {
    if (args[0] === "status") {
      scans++;
      const output = changed ? " M changed.txt\0" : "";
      await new Promise((resolve) => waiting.push(resolve));
      return { stdout: output };
    }
    return { stdout: args[0] === "rev-parse" ? "true" : args[0] === "symbolic-ref" ? "main" : "" };
  };
  os.homedir = () => directory;
  syncBuiltinESMExports();
  const { store } = await import("../server/store.ts");
  const { bus } = await import("../server/bus.ts");
  const { refreshGit, forgetGit } = await import("../server/git-monitor.ts");
  const events = [];
  const stop = bus.subscribe((event) => events.push(event));
  t.after(() => {
    stop();
    store.flush();
    childProcess.execFile = originalExecFile;
    os.homedir = originalHome;
    syncBuiltinESMExports();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const project = store.openProject(directory);
  const waitForScan = async () => {
    for (let index = 0; index < 50; index++) {
      if (waiting.length) return;
      await Promise.resolve();
    }
    throw new Error("Git scan did not start");
  };
  const first = Array.from({ length: 50 }, () => refreshGit(project.id));
  await waitForScan();
  assert.equal(scans, 1);
  assert.equal(waiting.length, 1);
  waiting.shift()();
  await Promise.all(first);
  assert.equal(events.filter((event) => event.t === "git.status").length, 1);

  const pending = refreshGit(project.id);
  await waitForScan();
  changed = true;
  const forced = Array.from({ length: 20 }, () => refreshGit(project.id, true));
  waiting.shift()();
  await waitForScan();
  assert.equal(scans, 3);
  assert.equal(waiting.length, 1);
  waiting.shift()();
  await Promise.all([pending, ...forced]);
  assert.equal(events.filter((event) => event.t === "git.status").at(-1).status.files[0].path, "changed.txt");

  const closing = refreshGit(project.id);
  await waitForScan();
  const count = events.length;
  store.projects.delete(project.id);
  forgetGit(project.id);
  waiting.shift()();
  await closing;
  assert.equal(events.length, count);
});
