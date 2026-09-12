import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { _electron as electron } from "playwright";
import { WebSocketServer } from "ws";

test(
  "browser navigation and repeated readiness preserve the user's window size",
  { timeout: 30000 },
  async (t) => {
    const directory = fs.mkdtempSync(join(os.tmpdir(), "citropy-window-"));
    fs.writeFileSync(
      join(directory, "window.json"),
      JSON.stringify({ width: 1100, height: 750, maximized: true }),
    );
    const display = spawn(
      "Xvfb",
      ["-displayfd", "3", "-screen", "0", "1600x1000x24"],
      { stdio: ["ignore", "ignore", "ignore", "pipe"] },
    );
    const [number] = await once(display.stdio[3], "data");
    const server = http.createServer((_, res) =>
      res.end(
        "<!doctype html><title>Citropy window fixture</title><h1>Workspace</h1>",
      ),
    );
    const wss = new WebSocketServer({ server });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    let desktop;
    t.after(async () => {
      await desktop?.close();
      for (const socket of wss.clients) socket.terminate();
      wss.close();
      server.closeAllConnections();
      server.close();
      display.kill();
      fs.rmSync(directory, { recursive: true, force: true });
    });
    desktop = await electron.launch({
      args: ["--no-sandbox", "--ozone-platform=x11", "desktop/main.mjs"],
      env: {
        ...process.env,
        DISPLAY: `:${String(number).trim()}`,
        CITROPY_URL: url,
        CITROPY_UI_URL: url,
        CITROPY_DESKTOP_DATA: directory,
        CITROPY_DESKTOP_TOKEN: "fixture",
      },
    });
    const page = await desktop.firstWindow();
    await page.waitForLoadState();
    const update = await page.evaluate(() => window.citropyDesktop.updateState());
    assert.equal(update.status, "unsupported");
    assert.match(update.message, /Development build/);
    assert.equal((await page.evaluate(() => window.citropyDesktop.updateCommand("install"))).status, "unsupported");
    await desktop.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window.isVisible())
        await new Promise((resolve) => window.once("ready-to-show", resolve));
    });
    await desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.unmaximize();
      window.setSize(1100, 750);
      globalThis.unexpectedMaximizes = 0;
      const maximize = window.maximize.bind(window);
      window.maximize = () => {
        globalThis.unexpectedMaximizes++;
        maximize();
      };
    });
    await desktop.evaluate(async ({ BrowserWindow, WebContentsView }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const view = new WebContentsView();
      window.contentView.addChildView(view);
      view.setBounds({ x: 300, y: 60, width: 600, height: 500 });
      await view.webContents.loadURL("data:text/html,<h1>First page</h1>");
      await view.webContents.loadURL("data:text/html,<h1>Second page</h1>");
      window.emit("ready-to-show");
      window.contentView.removeChildView(view);
      view.webContents.close();
    });
    assert.equal(
      await desktop.evaluate(() => globalThis.unexpectedMaximizes),
      0,
    );
    assert.deepEqual(
      await desktop.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].getSize(),
      ),
      [1100, 750],
    );
  },
);
