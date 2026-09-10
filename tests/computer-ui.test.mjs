import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

test("computer panel setup, preview, controls and settings", { timeout: 45000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-computer-ui-"));
  let server, browser;
  t.after(async () => { await browser?.close(); await server?.close(); await rm(directory, { recursive: true, force: true }); });
  server = await createServer({ configFile: false, cacheDir: join(directory, "cache"), root: fileURLToPath(new URL("..", import.meta.url)), plugins: [react()], logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  browser = await chromium.launch();
  const desktop = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await desktop.setContent('<style>body{margin:0;background:#17212b;color:#e5e9ed;font:18px sans-serif}header{padding:20px;background:#23303c}main{margin:50px;padding:35px;background:#263440;border-radius:12px;width:700px}h1{font-size:24px}p{color:#aab9c6;line-height:1.7}button{padding:12px 20px;background:#65a5ec;color:#122331;border:0;border-radius:8px;font:inherit}</style><header>Desktop test workspace</header><main><h1>Project notes</h1><p>Review the release checklist and prepare the next build.</p><p>Screen sharing keeps this application visible to the current conversation.</p><button>Open checklist</button></main>');
  const image = (await desktop.screenshot({ type: "jpeg" })).toString("base64");
  await desktop.close();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(7000);
  const errors = [], actions = [];
  let socket;
  let captures = 0;
  let state = { enabled: false, status: "idle", control: false, displays: [], activity: [] };
  const capabilities = { available: true, platform: "linux", backend: "wayland-portal" };
  const thread = { id: "chat", projectId: "workspace", provider: "claude", model: "sample", title: "Prepare the release", permissionMode: "manual", createdAt: 1, updatedAt: 1, status: "idle", running: false, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, contextTokens: 0, contextMax: 200000, turns: 0 } };
  const update = patch => { state = { ...state, ...patch }; socket.send(JSON.stringify({ t: "computer.state", computer: state })); };
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const [key, value] of Object.entries({ project: "workspace", thread: "chat", inspector: "1", inspectorWidth: "560", theme: "dark", uiScale: "120" })) localStorage.setItem(`citropy.${key}`, value);
  });
  await page.routeWebSocket("**/socket", connection => {
    socket = connection;
    socket.onMessage(raw => {
      const event = JSON.parse(raw);
      if (event.t === "thread.load") socket.send(JSON.stringify({ t: "thread.messages", threadId: "chat", messages: [{ id: "message", role: "assistant", ts: 1, parts: [{ id: "text", kind: "text", text: "I can inspect the application once you share a screen.", complete: true }] }] }));
    });
    socket.send(JSON.stringify({ t: "hello", snapshot: { projects: [{ id: "workspace", name: "Example workspace", path: "/example", isGit: false, lastOpened: 1 }], threads: [thread], providers: [{ id: "claude", label: "Claude Code", available: true, enabled: true, models: [{ id: "sample", label: "Claude Opus" }] }], panels: [{ id: "computer", kind: "computer", projectId: "workspace", title: "Computer", createdAt: 1 }], permissions: [], home: "/example", computer: state } }));
  });
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    let result = [];
    if (path === "/api/computer") {
      if (method === "PATCH") update({ enabled: route.request().postDataJSON().enabled });
      result = { state, capabilities };
    } else if (path === "/api/computer/start") {
      update({ status: "active", threadId: "chat", projectId: "workspace", control: true, startedAt: 10, shortcut: true, displays: [{ id: "screen", name: "Primary screen", width: 1200, height: 800 }] });
      result = state;
    } else if (path === "/api/computer/screenshot") {
      captures++;
      result = { id: `frame-${captures}`, displayId: "screen", width: 1200, height: 800, sourceWidth: 1200, sourceHeight: 800, capturedAt: Date.now(), image };
    } else if (path === "/api/computer/pause") {
      update({ status: route.request().postDataJSON().paused ? "paused" : "active" }); result = state;
    } else if (path === "/api/computer/stop") {
      update({ status: "idle", control: false, threadId: undefined, displays: [] }); result = state;
    } else if (path === "/api/computer/action") {
      actions.push(route.request().postDataJSON());
      update({ activity: [{ id: "click", action: "Click", actor: "user", status: "done", at: Date.now() }] }); result = state;
    } else if (path === "/api/computer/skill") result = { ok: true };
    await route.fulfill({ json: result });
  });
  await page.goto(server.resolvedUrls.local[0], { timeout: 20000 });
  await page.getByRole("button", { name: "Enable computer use", exact: true }).click();
  await page.getByRole("button", { name: "Share a screen", exact: true }).click();
  const preview = page.locator(".computer-preview img");
  await preview.waitFor();
  await page.getByRole("button", { name: "Stop computer use", exact: true }).waitFor();
  await page.screenshot({ path: "/tmp/citropy-computer-panel.png", animations: "disabled" });
  const bounds = await preview.boundingBox();
  assert.ok(Math.abs(bounds.width / bounds.height - 1.5) < 0.01);
  await page.getByRole("button", { name: "Interact", exact: true }).click();
  await preview.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
  await page.waitForFunction(() => document.querySelector('.computer-activity-row')?.textContent.includes('Click'));
  assert.ok(Math.abs(actions[0].x - 600) < 4 && Math.abs(actions[0].y - 400) < 4);
  await page.getByRole("button", { name: "Pause control", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Interact", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "Resume control", exact: true }).click();
  await page.getByRole("button", { name: "Enlarge computer preview", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Computer preview", exact: true });
  await dialog.waitFor();
  assert.equal(await dialog.locator("img").count(), 1);
  await page.screenshot({ path: "/tmp/citropy-computer-expanded.png", animations: "disabled" });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  for (const width of [1600, 960]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `/tmp/citropy-computer-${width}.png`, animations: "disabled" });
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Computer use", exact: true }).click();
  await page.getByRole("switch", { name: "Enable computer use", exact: true }).waitFor();
  const hiddenCaptures = captures;
  await new Promise(resolve => setTimeout(resolve, 1800));
  assert.equal(captures, hiddenCaptures);
  await page.getByRole("button", { name: "Restore skill", exact: true }).click();
  await page.getByRole("button", { name: "Restored", exact: true }).waitFor();
  for (const width of [1600, 960]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.screenshot({ path: `/tmp/citropy-computer-settings-${width}.png`, animations: "disabled" });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  await page.getByRole("button", { name: "Stop computer use", exact: true }).click();
  await page.getByRole("button", { name: "Stop computer use", exact: true }).waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
});
