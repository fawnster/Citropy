import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

test("renderer panels release background work and ignore stale replies", { timeout: 60_000 }, async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), "citropy-renderer-"));
  let server;
  let browser;
  t.after(async () => {
    await browser?.close();
    await server?.close();
    await rm(cacheDir, { recursive: true, force: true });
  });
  server = await createServer({
    configFile: false,
    cacheDir: join(cacheDir, "node_modules", ".vite"),
    root: fileURLToPath(new URL("..", import.meta.url)),
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  const requests = [];
  let slowFile;
  let connection;
  const panels = [
    { id: "first-browser", projectId: "workspace", kind: "browser", title: "First browser" },
    { id: "second-browser", projectId: "workspace", kind: "browser", title: "Second browser" },
    { id: "terminal", projectId: "workspace", kind: "terminal", title: "Terminal" },
    { id: "files", projectId: "workspace", kind: "files", title: "Files" },
  ];
  const snapshot = {
    projects: [{ id: "workspace", name: "Example workspace", path: "/example", isGit: false, lastOpened: 1 }],
    threads: [], providers: [], permissions: [], home: "/example", panels,
    browsers: panels.filter((panel) => panel.kind === "browser").map((panel) => ({ ...panel, url: "https://example.com/", loading: false, width: 1920, height: 1080, mobile: false, scale: 0.25 })),
  };
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/preview?**", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    if (path === "slow.txt") { slowFile = route; return; }
    await route.fulfill({ json: { name: path, path, mime: "text/plain", size: 16, text: "The current file" } });
  });
  await page.addInitScript(() => {
    localStorage.setItem("citropy.project", "workspace");
    localStorage.setItem("citropy.inspector", "1");
    localStorage.setItem("citropy.theme", "dark");
    const bodyObservers = new Set();
    const terminalObservers = new Set();
    const listeners = new Set();
    const bounds = [];
    const Mutation = window.MutationObserver;
    window.MutationObserver = class extends Mutation {
      observe(target, options) {
        if (target === document.body) bodyObservers.add(this);
        super.observe(target, options);
      }
      disconnect() {
        bodyObservers.delete(this);
        super.disconnect();
      }
    };
    const Resize = window.ResizeObserver;
    window.ResizeObserver = class extends Resize {
      observe(target, options) {
        if (target.classList.contains("term")) terminalObservers.add(this);
        super.observe(target, options);
      }
      disconnect() {
        terminalObservers.delete(this);
        super.disconnect();
      }
    };
    const listen = (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    };
    window.citropyDesktop = {
      windowState: async () => ({ maximized: false, fullscreen: false, platform: "linux", development: true, version: "0.1.0" }),
      windowCommand: async () => {},
      onWindowState: () => () => {},
      onNotification: () => () => {},
      onBrowserSelect: () => () => {},
      onAddressFocus: listen,
      onBrowserCover: listen,
      browserBounds: (id, position, visible, cover) => bounds.push({ id, position, visible, cover }),
    };
    window.panelResources = { bodyObservers, terminalObservers, listeners, bounds };
  });
  await page.routeWebSocket("**/socket", (socket) => {
    connection = socket;
    socket.onMessage((raw) => {
      const event = JSON.parse(raw);
      requests.push(event);
      const reply = (event) => socket.send(JSON.stringify(event));
      if (event.t === "file.tree") reply({ t: "file.tree", requestId: event.requestId, entries: ["slow.txt", "current.txt"].map((name) => ({ name, path: name, dir: false })) });
      if (event.t === "file.read" && event.path === "current.txt") reply({ t: "file.content", requestId: event.requestId, path: event.path, content: "The current file" });
      if (event.t === "term.open") reply({ t: "term.data", termId: event.termId, data: "\u001b[32mTerminal ready\u001b[0m\r\n" });
      if (event.t === "panel.close") {
        snapshot.panels = snapshot.panels.filter((panel) => panel.id !== event.id);
        snapshot.browsers = snapshot.browsers.filter((panel) => panel.id !== event.id);
        reply({ t: "panel.remove", id: event.id });
      }
      if (event.t === "browser.action" && event.input.action === "resize") {
        const state = snapshot.browsers.find((browser) => browser.id === event.id);
        const { width, height, mobile } = event.input;
        Object.assign(state, { width, height, mobile });
        reply({ t: "browser.state", browser: state });
      }
      if (event.t === "github.request") reply({ t: "github.result", requestId: event.requestId, result: { installed: false, repositories: [] } });
      if (event.t === "git.manage") reply({ t: "git.manage", requestId: event.requestId, error: "This test workspace has no Git repository." });
    });
    socket.send(JSON.stringify({ t: "hello", snapshot }));
  });
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByRole("tab", { name: "Second browser", exact: true }).waitFor();

  await t.test("browser resolution controls share presets and custom sizes with provider updates", async () => {
    await page.getByRole("tab", { name: "Second browser", exact: true }).click();
    const resolution = page.getByRole("button", { name: "Page resolution", exact: true });
    assert.match(await resolution.textContent(), /Desktop1920 × 1080/);
    await resolution.click();
    await page.getByRole("menuitem", { name: /Phone/ }).click();
    await page.waitForFunction(() => document.querySelector('#panel-body-second-browser .browser-viewport-trigger')?.textContent.includes('390 × 844'));
    assert.deepEqual(requests.findLast((event) => event.t === "browser.action"), { t: "browser.action", id: "second-browser", input: { action: "resize", width: 390, height: 844, mobile: true } });
    assert.equal(await page.getByRole("switch", { name: "Mobile mode", exact: true }).isChecked(), true);
    await page.getByRole("button", { name: "Rotate page viewport" }).click();
    await page.waitForFunction(() => document.querySelector('#panel-body-second-browser .browser-viewport-trigger')?.textContent.includes('844 × 390'));
    await resolution.click();
    await page.getByRole("menuitem", { name: /Custom size/ }).click();
    await page.getByRole("spinbutton", { name: "Width", exact: true }).fill("300");
    assert.equal(await page.getByRole("button", { name: "Apply size" }).isDisabled(), true);
    await page.getByRole("spinbutton", { name: "Width", exact: true }).fill("1280");
    await page.getByRole("spinbutton", { name: "Height", exact: true }).fill("720");
    await page.getByRole("switch", { name: "Mobile mode", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#panel-body-second-browser [role="switch"]').checked);
    assert.deepEqual(requests.findLast((event) => event.t === "browser.action").input, { action: "resize", width: 844, height: 390, mobile: false });
    await page.getByRole("button", { name: "Apply size" }).click();
    await page.waitForFunction(() => document.querySelector('#panel-body-second-browser .browser-viewport-trigger')?.textContent.includes('1280 × 720'));
    const state = snapshot.browsers.find((browser) => browser.id === "second-browser");
    Object.assign(state, { width: 768, height: 1024, mobile: true });
    connection.send(JSON.stringify({ t: "browser.state", browser: state }));
    await page.waitForFunction(() => document.querySelector('#panel-body-second-browser .browser-viewport-trigger')?.textContent.includes('Tablet768 × 1024'));
    const count = requests.filter((event) => event.t === "browser.action").length;
    for (const width of [1440, 960]) {
      await page.setViewportSize({ width, height: 900 });
      await resolution.click();
      await page.getByRole("menuitem", { name: /Custom size/ }).click();
      await page.getByRole("menu").waitFor({ state: "detached" });
      await settle();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await page.locator('#panel-body-second-browser .browser-viewport').evaluate((node) => node.scrollWidth <= node.clientWidth), true);
      await page.screenshot({ path: `/tmp/citropy-mobile-ui-${width}.png` });
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
    }
    assert.equal(requests.filter((event) => event.t === "browser.action").length, count);
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await t.test("only the visible browser observes layout, including after repeated tab switches", async () => {
    await page.waitForFunction(() => window.panelResources.bodyObservers.size === 1);
    assert.equal(await page.evaluate(() => window.panelResources.listeners.size), 4);
    for (let index = 0; index < 10; index++) {
      await page.getByRole("tab", { name: "First browser", exact: true }).click();
      await page.getByRole("tab", { name: "Second browser", exact: true }).click();
    }
    await settle();
    assert.equal(await page.evaluate(() => window.panelResources.bodyObservers.size), 1);
    const count = await page.evaluate(() => window.panelResources.bounds.length);
    await page.evaluate(() => {
      const paragraph = document.createElement("p");
      paragraph.hidden = true;
      document.body.append(paragraph);
      for (let index = 0; index < 100; index++) paragraph.textContent = String(index);
      paragraph.remove();
    });
    await settle();
    assert.equal(await page.evaluate(() => window.panelResources.bounds.length), count);
    await page.evaluate(() => {
      const overlay = document.createElement("div");
      overlay.id = "test-overlay";
      overlay.setAttribute("role", "dialog");
      document.body.append(overlay);
    });
    await page.waitForFunction(() => window.panelResources.bounds.at(-1).cover === true);
    assert.equal(await page.evaluate(() => window.panelResources.bounds.at(-1).visible), false);
    await page.evaluate(() => document.getElementById("test-overlay").remove());
    await page.waitForFunction(() => window.panelResources.bounds.at(-1).visible === true);
    await page.getByRole("button", { name: "Close First browser", exact: true }).click();
    await page.getByRole("button", { name: "Close Second browser", exact: true }).click();
    await page.waitForFunction(() => window.panelResources.bodyObservers.size === 0 && window.panelResources.listeners.size === 0);
  });

  await t.test("terminal tab switching preserves the session and reconnect replays only once", async () => {
    await page.getByRole("tab", { name: "Terminal", exact: true }).click();
    await page.locator(".xterm").waitFor();
    await settle();
    assert.equal(requests.filter((event) => event.t === "term.open").length, 1);
    for (let index = 0; index < 10; index++) {
      await page.getByRole("tab", { name: "Files", exact: true }).click();
      assert.equal(await page.evaluate(() => window.panelResources.terminalObservers.size), 0);
      await page.getByRole("tab", { name: "Terminal", exact: true }).click();
    }
    assert.equal(requests.filter((event) => event.t === "term.open").length, 1);
    connection.close();
    await page.getByText("Reconnecting to your terminal…").waitFor();
    await page.getByText("Reconnecting to your terminal…").waitFor({ state: "hidden" });
    await settle();
    assert.equal(requests.filter((event) => event.t === "term.open").length, 2);
    await page.getByRole("button", { name: "Close Terminal", exact: true }).click();
    await page.locator(".xterm").waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => window.panelResources.terminalObservers.size), 0);
  });

  await t.test("closing a file prevents its late result from replacing a newer preview", async () => {
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    const loading = page.waitForRequest((request) => request.url().includes("/api/preview?"));
    await page.getByRole("button", { name: "slow.txt", exact: true }).click();
    await page.locator(".preview").waitFor();
    await loading;
    assert.ok(slowFile);
    await page.locator(".preview").getByRole("button", { name: "Close preview", exact: true }).click();
    await page.getByRole("button", { name: "current.txt", exact: true }).click();
    await page.locator(".preview-body").getByText("The current file", { exact: true }).waitFor();
    await slowFile.fulfill({ json: { name: "slow.txt", path: "slow.txt", mime: "text/plain", size: 22, text: "Obsolete file contents" } });
    await settle();
    assert.equal(await page.locator(".preview-body").textContent(), "The current file");
    assert.equal(await page.getByText("Obsolete file contents").count(), 0);
    await page.locator(".preview").getByRole("button", { name: "Close preview", exact: true }).click();
  });

  await t.test("settings and repository screens load on demand at desktop and narrow widths", async () => {
    for (const width of [1440, 960]) {
      await page.setViewportSize({ width, height: 900 });
      for (const name of ["Settings", "Source control", "GitHub"]) {
        await page.getByRole("button", { name, exact: true }).click();
        await page.getByRole("button", { name: "Back to chat", exact: true }).waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        await page.getByRole("button", { name: "Back to chat", exact: true }).click();
      }
    }
  });
  assert.deepEqual(errors, []);
});
