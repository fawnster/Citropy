import assert from "node:assert/strict";
import { test } from "node:test";
import childProcess from "node:child_process";
import { promisify } from "node:util";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("native workspace selection and cancellation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "citropy folder "));
  const original = childProcess.execFile;
  let result = { stdout: `${directory}\n` };
  let failure;
  let calls = 0;
  childProcess.execFile = Object.assign(() => {}, {
    [promisify.custom]: async (binary, args) => {
      calls++;
      assert.equal(binary, "kdialog");
      assert.equal(args[0], "--getexistingdirectory");
      if (failure) throw failure;
      return result;
    },
  });
  syncBuiltinESMExports();
  const saved = new Map();
  globalThis.localStorage = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: (key) => saved.delete(key) };
  try {
    const { chooseFolder } = await import("../server/folder-picker.ts");
    const first = chooseFolder();
    assert.equal(chooseFolder(), first);
    assert.equal(await first, directory);
    assert.equal(calls, 1);
    failure = Object.assign(new Error("Cancelled"), { code: 1 });
    assert.equal(await chooseFolder(), null);
    failure = Object.assign(new Error("Not installed"), { code: "ENOENT" });
    await assert.rejects(chooseFolder(), /not installed/);
    failure = undefined;
    result = { stdout: `${directory}/missing\n` };
    await assert.rejects(chooseFolder());
    const { useApp, applyEvent } = await import("../web/src/lib/store.ts");
    const state = { ...useApp.getState(), activeProjectId: "existing", activeThreadId: "thread", choosingWorkspace: true };
    applyEvent(state, { t: "project.chosen", projectId: null });
    assert.equal(state.activeProjectId, "existing");
    assert.equal(state.activeThreadId, "thread");
    assert.equal(state.choosingWorkspace, false);
    applyEvent(state, { t: "project.chosen", projectId: "selected" });
    assert.equal(state.activeProjectId, "selected");
    assert.equal(state.activeThreadId, null);
    assert.equal(saved.get("citropy.project"), "selected");
  } finally {
    childProcess.execFile = original;
    syncBuiltinESMExports();
    delete globalThis.localStorage;
    rmSync(directory, { recursive: true, force: true });
  }
});
