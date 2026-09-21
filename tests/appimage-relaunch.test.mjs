import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { spawnAppImageRelaunch } from "../desktop/appimage-relaunch.mjs";

const until = async (probe, message) => {
  const deadline = Date.now() + 8000;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await probe();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await delay(50);
  }
  throw new Error(message + (last instanceof Error ? `: ${last.message}` : ""));
};

test("AppImage relaunch rejects unsafe paths", () => {
  const base = {
    downloadedFile: "/tmp/Citropy-next.AppImage",
    parentPid: 1,
    logFile: "/tmp/citropy-update.log",
  };
  assert.throws(
    () => spawnAppImageRelaunch({ ...base, appImage: "Citropy.AppImage" }),
    /absolute path/,
  );
  assert.throws(
    () =>
      spawnAppImageRelaunch({
        ...base,
        appImage: "/tmp/Citropy.AppImage",
        downloadedFile: "/tmp/Citropy.AppImage",
      }),
    /replace itself/,
  );
  assert.throws(
    () =>
      spawnAppImageRelaunch({
        ...base,
        appImage: "/tmp/Citropy.AppImage",
        parentPid: 0,
      }),
    /process id/,
  );
});

test(
  "AppImage apply waits for the running process before replacing and relaunching",
  { timeout: 15000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "citropy-appimage-relaunch-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const appImage = join(directory, "Citropy.AppImage");
    const downloaded = join(directory, "Citropy-next.AppImage");
    const launched = join(directory, "launched");
    const logFile = join(directory, "update.log");
    await writeFile(appImage, "old-install");
    await writeFile(
      downloaded,
      `#!/bin/sh\nprintf 'APPDIR=%s\\nAPPIMAGE=%s\\n' "\${APPDIR-unset}" "\${APPIMAGE-unset}" > ${JSON.stringify(launched)}\n`,
    );
    await chmod(downloaded, 0o755);
    const parent = spawn("sleep", ["30"], { stdio: "ignore" });
    t.after(() => {
      parent.kill("SIGTERM");
    });
    spawnAppImageRelaunch({
      appImage,
      downloadedFile: downloaded,
      parentPid: parent.pid,
      logFile,
    });
    await delay(400);
    assert.equal(await readFile(appImage, "utf8"), "old-install");
    await assert.rejects(readFile(launched), /ENOENT/);
    parent.kill("SIGTERM");
    await until(
      async () => (await readFile(appImage, "utf8")).startsWith("#!/bin/sh"),
      "the installed AppImage should be replaced after the parent exits",
    );
    const mark = await until(
      async () => readFile(launched, "utf8"),
      "the new AppImage should launch after the parent exits",
    );
    assert.match(mark, /APPDIR=unset/);
    assert.match(mark, /APPIMAGE=unset/);
    assert.match(await readFile(logFile, "utf8"), /Replaced .* and relaunched/);
  },
);

test(
  "AppImage restart waits for the running process then launches the current file",
  { timeout: 15000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "citropy-appimage-restart-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const appImage = join(directory, "Citropy.AppImage");
    const launched = join(directory, "launched");
    const logFile = join(directory, "update.log");
    await writeFile(
      appImage,
      `#!/bin/sh\nprintf relaunched > ${JSON.stringify(launched)}\n`,
    );
    await chmod(appImage, 0o755);
    const parent = spawn("sleep", ["30"], { stdio: "ignore" });
    t.after(() => {
      parent.kill("SIGTERM");
    });
    spawnAppImageRelaunch({
      appImage,
      parentPid: parent.pid,
      logFile,
    });
    await delay(400);
    await assert.rejects(readFile(launched), /ENOENT/);
    parent.kill("SIGTERM");
    await until(
      async () => readFile(launched, "utf8"),
      "the current AppImage should launch after the parent exits",
    );
    assert.match(await readFile(logFile, "utf8"), /Relaunched /);
  },
);
