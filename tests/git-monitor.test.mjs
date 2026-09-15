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

  const threads = Array.from({ length: 20 }, (_, index) => store.createThread({ projectId: project.id, provider: "claude", title: `Thread ${index}`, permissionMode: "manual" }));
  const scansBefore = scans;
  const eventsBefore = events.length;
  const shared = [refreshGit(project.id), ...threads.map(thread => refreshGit(project.id, false, thread.id))];
  await waitForScan();
  assert.equal(scans - scansBefore, 1);
  assert.equal(waiting.length, 1);
  waiting.shift()();
  await Promise.all(shared);
  const updates = events.slice(eventsBefore).filter(event => event.t === "git.status");
  assert.equal(updates.length, 20);
  assert.deepEqual(new Set(updates.map(event => event.threadId)), new Set(threads.map(thread => thread.id)));

  threads[0].workspacePath = `${directory}/worktree`;
  const separateBefore = scans;
  const separate = [refreshGit(project.id, false, threads[0].id), refreshGit(project.id, false, threads[1].id)];
  await waitForScan();
  assert.equal(scans - separateBefore, 2);
  assert.equal(waiting.length, 2);
  waiting.shift()();
  waiting.shift()();
  await Promise.all(separate);

  const removedBefore = events.length;
  const removing = [refreshGit(project.id, true, threads[1].id), refreshGit(project.id, false, threads[2].id)];
  await waitForScan();
  store.threads.delete(threads[1].id);
  threads[2].workspacePath = `${directory}/other-worktree`;
  waiting.shift()();
  await Promise.all(removing);
  assert.equal(events.slice(removedBefore).filter(event => event.t === "git.status").length, 0);

  const sharedBefore = events.length;
  const refreshing = [refreshGit(project.id, false, threads[3].id), refreshGit(project.id, false, threads[4].id)];
  await waitForScan();
  changed = false;
  refreshing.push(refreshGit(project.id, true, threads[4].id));
  waiting.shift()();
  await waitForScan();
  assert.equal(waiting.length, 1);
  waiting.shift()();
  await Promise.all(refreshing);
  const refreshed = events.slice(sharedBefore).filter(event => event.t === "git.status");
  assert.deepEqual(new Set(refreshed.map(event => event.threadId)), new Set([threads[3].id, threads[4].id]));
  assert.ok(refreshed.every(event => event.status.clean));

  const closing = refreshGit(project.id);
  await waitForScan();
  const count = events.length;
  store.projects.delete(project.id);
  forgetGit(project.id);
  waiting.shift()();
  await closing;
  assert.equal(events.length, count);
});
