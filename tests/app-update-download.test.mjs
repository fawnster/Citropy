import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { _electron as electron } from "playwright";

const root = fileURLToPath(new URL("..", import.meta.url));
test(
  "Electron downloads and verifies release files before allowing an explicit install",
  { timeout: 35000 },
  async (t) => {
    const folder = await mkdtemp(join(tmpdir(), "citropy-update-download-"));
    const display = spawn(
      "Xvfb",
      ["-displayfd", "3", "-screen", "0", "1200x800x24"],
      { stdio: ["ignore", "ignore", "ignore", "pipe"] },
    );
    const [number] = await once(display.stdio[3], "data");
    const payload = Buffer.alloc(512 * 1024, "citropy-release-fixture");
    let corrupt = false;
    const sha512 = createHash("sha512").update(payload).digest("base64");
    const server = createServer((req, res) => {
      if (req.url.startsWith("/latest-linux.yml")) {
        res
          .writeHead(200, { "content-type": "text/yaml" })
          .end(
            `version: 0.2.0\nfiles:\n  - url: Citropy-0.2.0.AppImage\n    sha512: ${sha512}\n    size: ${payload.length}\npath: Citropy-0.2.0.AppImage\nsha512: ${sha512}\nreleaseDate: '2026-09-12T00:00:00.000Z'\n`,
          );
      } else if (req.url === "/Citropy-0.2.0.AppImage") {
        res
          .writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": payload.length,
          })
          .end(corrupt ? Buffer.alloc(payload.length, "broken") : payload);
      } else res.writeHead(404).end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    let desktop;
    t.after(async () => {
      await desktop?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      display.kill();
      await rm(folder, { recursive: true, force: true });
    });
    await writeFile(
      join(folder, "package.json"),
      JSON.stringify({
        name: "citropy-update-test",
        version: "0.1.0",
        type: "module",
        main: "main.mjs",
      }),
    );
    await writeFile(
      join(folder, "dev-app-update.yml"),
      `provider: generic\nurl: ${url}\nupdaterCacheDirName: citropy-test-update\n`,
    );
    await writeFile(join(folder, "current.AppImage"), "original installation");
    await writeFile(
      join(folder, "main.mjs"),
      `
import { app, BrowserWindow } from "electron";
import updaterModule from ${JSON.stringify(join(root, "node_modules/electron-updater/out/main.js"))};
import { createAppUpdater } from ${JSON.stringify(join(root, "desktop/updates.mjs"))};
app.setPath('userData', ${JSON.stringify(join(folder, "user-data"))});
app.setPath('cache', ${JSON.stringify(join(folder, "cache"))});
app.whenReady().then(async () => {
const updater = new updaterModule.AppImageUpdater({ provider: 'generic', url: ${JSON.stringify(url)} });
updater.forceDevUpdateConfig = true;
updater.disableDifferentialDownload = true;
updater.updateConfigPath = ${JSON.stringify(join(folder, "dev-app-update.yml"))};
globalThis.installs = 0;
updater.quitAndInstall = () => { globalThis.installs++; };
globalThis.control = createAppUpdater({ updater, version: '0.1.0', emit() {}, prepareInstall: async () => {} });
const window = new BrowserWindow({ show: false });
await window.loadURL('data:text/html,<h1>Updater fixture</h1>');
app.on('before-quit', () => globalThis.control.dispose());
});
`,
    );
    for (const broken of [true, false]) {
      corrupt = broken;
      desktop = await electron.launch({
        args: ["--no-sandbox", "--ozone-platform=x11", folder],
        env: {
          ...process.env,
          DISPLAY: `:${String(number).trim()}`,
          APPIMAGE: join(folder, "current.AppImage"),
          XDG_CACHE_HOME: join(folder, "cache"),
          HOME: folder,
        },
      });
      await desktop.firstWindow();
      await desktop.evaluate(() => globalThis.control.command("check"));
      for (
        let i = 0;
        i < 100 &&
        (await desktop.evaluate(() => globalThis.control.state())).status ===
          "checking";
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(
        (await desktop.evaluate(() => globalThis.control.state())).status,
        "available",
      );
      assert.equal(await desktop.evaluate(() => globalThis.installs), 0);
      await desktop.evaluate(() => globalThis.control.command("download"));
      for (
        let i = 0;
        i < 100 &&
        (await desktop.evaluate(() => globalThis.control.state())).status ===
          "downloading";
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 30));
      const state = await desktop.evaluate(() => globalThis.control.state());
      assert.equal(
        state.status,
        broken ? "error" : "ready",
        JSON.stringify(state),
      );
      if (broken) assert.match(state.message, /verification/);
      else {
        assert.equal(await desktop.evaluate(() => globalThis.installs), 0);
        await desktop.evaluate(() => globalThis.control.command("install"));
        assert.equal(await desktop.evaluate(() => globalThis.installs), 1);
      }
      assert.equal(
        await readFile(join(folder, "current.AppImage"), "utf8"),
        "original installation",
      );
      await desktop.close();
      desktop = undefined;
    }
  },
);
