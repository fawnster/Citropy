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

test("new windows fit the display and oversized saved windows stay on screen", { timeout: 30000 }, async t => {
  const server = http.createServer((_, res) => res.end("<!doctype html><title>Citropy window fixture</title><h1>Workspace</h1>"));
  const wss = new WebSocketServer({ server });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    server.closeAllConnections();
    server.close();
  });
  for (const { screen, size, saved } of [
    { screen: [1920, 1080], size: [1440, 900] },
    { screen: [1366, 768], size: [1302, 704] },
    { screen: [1366, 768], size: [1366, 768], saved: { width: 2000, height: 1200 } },
    { screen: [800, 600], size: [800, 600] },
  ]) {
    await t.test(`${screen.join("×")} ${saved ? "restored" : "default"}`, async t => {
      const directory = fs.mkdtempSync(join(os.tmpdir(), "citropy-window-fit-"));
      if (saved) fs.writeFileSync(join(directory, "window.json"), JSON.stringify(saved));
      const display = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", `${screen[0]}x${screen[1]}x24`], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
      const [number] = await once(display.stdio[3], "data");
      let desktop;
      t.after(async () => {
        await desktop?.close();
        display.kill();
        fs.rmSync(directory, { recursive: true, force: true });
      });
      desktop = await electron.launch({
        args: ["--no-sandbox", "--ozone-platform=x11", "desktop/main.mjs"],
        env: { ...process.env, DISPLAY: `:${String(number).trim()}`, CITROPY_URL: url, CITROPY_UI_URL: url, CITROPY_DESKTOP_DATA: directory, CITROPY_DESKTOP_TOKEN: "fixture" },
      });
      await (await desktop.firstWindow()).waitForLoadState();
      const bounds = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
      assert.deepEqual(bounds, { x: Math.round((screen[0] - size[0]) / 2), y: Math.round((screen[1] - size[1]) / 2), width: size[0], height: size[1] });
    });
  }
});

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
    let defaults = { permissionMode: "plan" };
    const requests = [];
    const server = http.createServer(async (req, res) => {
      if (req.url === "/api/projects/defaults") {
        requests.push(req.method);
        if (req.method === "PATCH") {
          let body = "";
          for await (const chunk of req) body += chunk;
          defaults = JSON.parse(body).settings;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(defaults));
        return;
      }
      res.end("<!doctype html><title>Citropy window fixture</title><h1>Workspace</h1>");
    });
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
    assert.deepEqual(await page.evaluate(() => window.citropyDesktop.configureProjectDefaults()), { permissionMode: "plan" });
    const settings = { permissionMode: "manual", provider: "opencode", model: "remote/model", effort: "high" };
    assert.deepEqual(await page.evaluate(settings => window.citropyDesktop.configureProjectDefaults(settings), settings), settings);
    assert.deepEqual(defaults, settings);
    assert.deepEqual(requests, ["GET", "PATCH"]);
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
