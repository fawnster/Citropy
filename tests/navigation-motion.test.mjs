import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

test("navigation stays bounded and motion releases its resources", { timeout: 120_000 }, async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), "citropy-navigation-motion-"));
  const server = await createServer({
    configFile: false, cacheDir,
    root: fileURLToPath(new URL("..", import.meta.url)), plugins: [react()], logLevel: "error",
    server: { host: "127.0.0.1", port: 0, watch: null },
  });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await rm(cacheDir, { recursive: true, force: true }); });
  const warmup = await browser.newPage();
  await warmup.goto(server.resolvedUrls.local[0], { timeout: 120_000 });
  await warmup.close();
  const threads = Array.from({ length: 1000 }, (_, index) => ({
    id: `thread-${index}`, projectId: "workspace", provider: "claude", model: "sample",
    title: index === 0 ? "Review navigation and improve the conversation list" : `Conversation ${index}`,
    permissionMode: "manual", createdAt: index + 1, updatedAt: 2000 - index,
    status: "idle", running: false, pinned: index < 2, workspaceBranch: "main",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, contextTokens: 0, contextMax: 200000, turns: 0 },
  }));
  async function fixture(test, { count = 1000 } = {}) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(20000);
    const errors = [];
    const requests = [];
    let connection;
    page.on("pageerror", (error) => errors.push(error.message));
    test.after(async () => { await page.close(); assert.deepEqual(errors, []); });
    await page.addInitScript(() => {
      for (const [key, value] of Object.entries({ project: "workspace", thread: "thread-0", sidebar: "1", inspector: "0", theme: "dark", uiScale: "120", compactNavigation: "1" })) localStorage.setItem(`citropy.${key}`, value);
      const observers = new Set();
      const frames = new Set();
      const Resize = window.ResizeObserver;
      window.ResizeObserver = class extends Resize {
        targets = new Set();
        observe(target, options) { this.targets.add(target); observers.add(this); super.observe(target, options); }
        unobserve(target) { this.targets.delete(target); if (!this.targets.size) observers.delete(this); super.unobserve(target); }
        disconnect() { this.targets.clear(); observers.delete(this); super.disconnect(); }
      };
      const request = window.requestAnimationFrame;
      const cancel = window.cancelAnimationFrame;
      window.requestAnimationFrame = (callback) => {
        const id = request((time) => { frames.delete(id); callback(time); });
        frames.add(id);
        return id;
      };
      window.cancelAnimationFrame = (id) => { frames.delete(id); cancel(id); };
      window.navigationResources = { observers, frames };
    });
    await page.route("**/api/threads/reorder?*", route => {
      const { ids } = route.request().postDataJSON();
      requests.push({ t: "reorder", ids });
      for (const [position, id] of ids.slice(0, 8).entries()) connection.send(JSON.stringify({ t: "thread.upsert", thread: { ...threads.find(thread => thread.id === id), position } }));
      return route.fulfill({ json: { ok: true } });
    });
    await page.routeWebSocket("**/socket", (socket) => {
      connection = socket;
      socket.onMessage((raw) => {
        const event = JSON.parse(raw);
        requests.push(event);
        if (event.t === "thread.load") socket.send(JSON.stringify({ t: "thread.messages", threadId: event.id, messages: [{ id: `message-${event.id}`, role: "assistant", ts: 1, parts: [{ id: `text-${event.id}`, kind: "text", text: "Ready to work.", complete: true }] }] }));
        if (event.t === "github.request") socket.send(JSON.stringify({ t: "github.result", requestId: event.requestId, result: { installed: false, repositories: [] } }));
        if (event.t === "thread.search") socket.send(JSON.stringify({ t: "thread.search", query: event.query, projectId: event.projectId, results: [{ threadId: "thread-999", snippet: "Search result from the oldest conversation" }] }));
      });
      socket.send(JSON.stringify({ t: "hello", snapshot: {
        projects: [{ id: "workspace", name: "Example workspace", path: "/example", isGit: false, lastOpened: 1 }], threads: threads.slice(0, count),
        providers: [{ id: "claude", label: "Claude Code", available: true, enabled: true, models: [{ id: "sample", label: "Claude Sonnet 5" }] }],
        permissions: [], home: "/example", panels: [{ id: "changes", projectId: "workspace", kind: "changes", title: "Changes" }],
      } }));
    });
    await page.goto(server.resolvedUrls.local[0]);
    await page.locator(".thread-card").first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    const settle = () => page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running" || animation.effect.getTiming().iterations === Infinity));
    await settle();
    return { page, settle, requests, emit: event => connection.send(JSON.stringify(event)) };
  }

  for (const count of [6, 1000]) await t.test(`live list changes cancel dragging cleanly with ${count} tasks`, async test => {
    const { page, settle, requests, emit } = await fixture(test, { count });
    const entry = page.locator('.thread-entry[data-thread-id="thread-2"]');
    const bounds = await entry.boundingBox();
    await page.mouse.move(bounds.x + 70, bounds.y + 25);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 80, bounds.y + 40, { steps: 4 });
    await page.locator('.thread-entry[data-thread-id="thread-2"][data-dragging="true"]').waitFor();
    emit({ t: "thread.upsert", thread: { ...threads[2], changedFiles: 1 } });
    await page.waitForFunction(async () => (await import("/web/src/lib/store.ts")).useApp.getState().threads["thread-2"].changedFiles === 1);
    assert.equal(await entry.getByText("1 file", { exact: true }).count(), 0);
    assert.ok(Math.abs((await entry.boundingBox()).height - bounds.height) < 1);
    assert.equal(await entry.getAttribute("data-dragging"), "true");
    emit({ t: "thread.remove", id: "thread-2" });
    await entry.waitFor({ state: "detached" });
    await page.mouse.move(bounds.x + 80, bounds.y + 50);
    await page.mouse.up();
    await page.locator('.thread-list[data-dragging="false"]').waitFor();
    await settle();
    assert.equal(requests.some(event => event.t === "reorder"), false);
    const next = page.locator('.thread-entry[data-thread-id="thread-3"] .thread-row');
    await next.click();
    assert.equal(await next.getAttribute("aria-current"), "page");
    const nextBounds = await next.boundingBox();
    await page.mouse.move(nextBounds.x + 70, nextBounds.y + 25);
    await page.mouse.down();
    await page.mouse.move(nextBounds.x + 80, nextBounds.y + 40, { steps: 4 });
    await page.locator('.thread-entry[data-thread-id="thread-3"][data-dragging="true"]').waitFor();
    emit({ t: "thread.upsert", thread: { ...threads[3], pinned: true } });
    await page.locator('.thread-list[data-dragging="false"]').waitFor();
    await page.mouse.up();
    assert.equal(requests.some(event => event.t === "reorder"), false);
  });

  await t.test("thread rows omit passive metadata and show compact, named activity without changing height", async test => {
    const { page, emit } = await fixture(test, { count: 6 });
    const card = page.locator('.thread-entry[data-thread-id="thread-2"] .thread-card');
    const height = (await card.boundingBox()).height;
    for (const [status, label] of [["idle", null], ["stopped", null], ["working", "Working"], ["thinking", "Thinking"], ["queued", "Queued"], ["awaiting", "Needs input"], ["error", "Failed"]]) {
      emit({ t: "thread.upsert", thread: { ...threads[2], status, running: status === "working" || status === "thinking", changedFiles: 19 } });
      await page.waitForFunction(async status => (await import("/web/src/lib/store.ts")).useApp.getState().threads["thread-2"].status === status, status);
      if (label) await card.getByRole("img", { name: label, exact: true }).waitFor();
      else assert.equal(await card.locator(".thread-status").count(), 0);
      assert.doesNotMatch(await card.innerText(), /19 files|stopped|working|thinking|queued|Needs input|Failed/);
      assert.ok(Math.abs((await card.boundingBox()).height - height) < 1, status);
    }
  });

  await t.test("thread previews reveal details without moving rows, blocking clicks, or surviving navigation", async test => {
    const { page, emit, requests } = await fixture(test);
    const details = { ...threads[2], status: "stopped", changedFiles: 12, workspacePath: "/example/a-long-workspace-folder", workspaceBranch: "feature/improve-the-workspace-navigation" };
    emit({ t: "thread.upsert", thread: details });
    const row = page.locator('.thread-entry[data-thread-id="thread-2"] .thread-row');
    const preview = page.locator('.thread-preview[role="tooltip"]');
    for (const [width, scale] of [[1440, 120], [600, 150]]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(async scale => (await import("/web/src/lib/store.ts")).setUiScale(scale), scale);
      await page.mouse.move(width - 10, 10);
      const before = await row.boundingBox();
      await row.hover({ position: { x: 70, y: 15 } });
      await page.waitForTimeout(150);
      assert.equal(await preview.count(), 0);
      await preview.waitFor();
      await preview.getByText("Stopped", { exact: true }).waitFor();
      assert.match(await preview.innerText(), /Claude Sonnet 5\s+Claude Code/);
      assert.match(await preview.innerText(), /12 files/);
      assert.match(await preview.innerText(), /a-long-workspace-folder/);
      assert.match(await preview.innerText(), /feature\/improve-the-workspace-navigation/);
      assert.equal(await row.getAttribute("aria-describedby"), await preview.getAttribute("id"));
      assert.deepEqual(await row.boundingBox(), before);
      const bounds = await preview.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= 900, JSON.stringify(bounds));
      await preview.hover();
      await page.waitForTimeout(200);
      assert.equal(await preview.isVisible(), true);
      await page.screenshot({ path: `/tmp/citropy-thread-hover-${width}.png`, animations: "disabled" });
      await page.keyboard.press("Escape");
      await preview.waitFor({ state: "detached" });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(async () => (await import("/web/src/lib/store.ts")).setUiScale(120));
    await page.mouse.move(1400, 80);
    await row.hover({ position: { x: 70, y: 15 } });
    await page.waitForTimeout(100);
    await page.locator(".rail-list").evaluate(node => node.scrollTop += 30);
    await page.waitForTimeout(550);
    assert.equal(await preview.count(), 0);
    await page.locator(".rail-list").evaluate(node => node.scrollTop = 0);
    await page.mouse.move(1400, 80);
    await row.hover({ position: { x: 70, y: 15 } });
    await preview.waitFor();
    const bounds = await row.boundingBox();
    await page.mouse.move(bounds.x + 70, bounds.y + 15);
    await page.mouse.down();
    await preview.waitFor({ state: "detached" });
    await page.mouse.up();
    await page.keyboard.press("Tab");
    await row.focus();
    await preview.waitFor();
    await page.keyboard.press("Escape");
    await preview.waitFor({ state: "detached" });
    await page.keyboard.press("Enter");
    assert.equal(await row.getAttribute("aria-current"), "page");
    assert.ok(requests.some(event => event.t === "thread.load" && event.id === "thread-2"));
    assert.equal(await preview.count(), 0);
  });

  await t.test("the whole thread card opens its conversation while actions stay independent", async test => {
    const { page, requests } = await fixture(test, { count: 6 });
    const card = page.locator('.thread-entry[data-thread-id="thread-1"] .thread-card');
    const reset = () => page.locator('.thread-entry[data-thread-id="thread-0"] .thread-row').click();
    for (const target of [".thread-row-title", ".thread-provider", ".thread-row-footer"]) {
      await reset();
      await card.locator(target).click();
      assert.equal(await card.locator(".thread-row").getAttribute("aria-current"), "page", target);
    }
    for (const position of [{ x: 2, y: 2 }, { x: 2, y: -2 }, { x: -2, y: -2 }]) {
      await reset();
      const bounds = await card.boundingBox();
      await page.mouse.click(bounds.x + (position.x < 0 ? bounds.width + position.x : position.x), bounds.y + (position.y < 0 ? bounds.height + position.y : position.y));
      assert.equal(await card.locator(".thread-row").getAttribute("aria-current"), "page", JSON.stringify(position));
    }
    await reset();
    const loads = () => requests.filter(event => event.t === "thread.load" && event.id === "thread-1").length;
    const before = loads();
    await page.locator(".canvas").hover();
    assert.equal(await card.locator(".thread-row-actions").evaluate(node => getComputedStyle(node).pointerEvents), "none");
    const summary = await card.locator(".thread-row-summary").boundingBox();
    await card.hover();
    const visibleSummary = await card.locator(".thread-row-summary").boundingBox();
    assert.ok(Math.abs(summary.width - visibleSummary.width) < 1);
    assert.ok(Math.abs(summary.x - visibleSummary.x) < 1);
    await card.locator('.thread-row-actions [aria-haspopup="menu"]').click();
    await page.getByRole("menuitem", { name: "Rename…", exact: true }).click();
    await page.getByRole("dialog", { name: "Rename conversation" }).waitFor();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await card.hover();
    await card.locator(".thread-row-finish").click();
    assert.ok(requests.some(event => event.t === "thread.finish" && event.id === "thread-1"));
    await card.locator(".thread-row-kill").click();
    await page.getByRole("dialog").waitFor();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    assert.equal(loads(), before);
    assert.equal(await card.locator(".thread-row").getAttribute("aria-current"), null);
    for (const key of ["Enter", "Space"]) {
      await reset();
      await card.locator(".thread-row").focus();
      await page.keyboard.press(key);
      assert.equal(await card.locator(".thread-row").getAttribute("aria-current"), "page");
    }
    assert.equal(requests.filter(event => event.t === "reorder").length, 0);
  });

  await t.test("large lists stay bounded, remain searchable, and keep keyboard focus while scrolling", async (test) => {
    const { page, requests } = await fixture(test);
    assert.ok(await page.locator(".thread-card").count() < 25);
    await page.locator(".rail-list").evaluate((node) => { node.scrollTop = node.scrollHeight; });
    const last = page.locator('.thread-row[aria-label="Conversation 999"]');
    await last.waitFor();
    await last.focus();
    await page.locator(".rail-list").evaluate((node) => { node.scrollTop = 0; });
    await page.locator('.thread-row[aria-label="Conversation 1"]').waitFor();
    assert.equal(await last.evaluate((node) => node === document.activeElement), true);
    assert.ok(await page.locator(".thread-card").count() < 25);
    await page.getByRole("textbox", { name: "Find a conversation", exact: true }).fill("oldest");
    await page.getByText("Search result from the oldest conversation", { exact: true }).waitFor();
    assert.equal(await page.locator(".thread-card").count(), 1);
    await last.click();
    await page.locator('.thread-row[aria-label="Conversation 999"][aria-current="page"]').waitFor();
    assert.ok(requests.some((event) => event.t === "thread.load" && event.id === "thread-999"));
    await page.getByRole("textbox", { name: "Find a conversation", exact: true }).fill("");
    await last.waitFor();
    assert.ok(await page.locator(".thread-card").count() < 25);
  });

  await t.test("dragging moves the original row, shifts neighbors, and releases its resources", async test => {
    const { page, settle, requests } = await fixture(test);
    await page.setViewportSize({ width: 1440, height: 1100 });
    const entry = id => page.locator(`.thread-entry[data-thread-id="thread-${id}"]`);
    const begin = async id => {
      const bounds = await entry(id).boundingBox();
      await page.mouse.move(bounds.x + 70, bounds.y + 25);
      await page.mouse.down();
      await page.mouse.move(bounds.x + 80, bounds.y + 35, { steps: 5 });
      await page.locator(`.thread-entry[data-thread-id="thread-${id}"][data-dragging="true"]`).waitFor();
      return bounds;
    };
    const pointAt = async (id, edge) => {
      const bounds = await entry(id).locator("..").boundingBox();
      const point = { x: bounds.x + 80, y: bounds.y + bounds.height * (edge === "before" ? 0.2 : 0.8) };
      await page.mouse.move(point.x, point.y, { steps: 8 });
      return point;
    };
    const done = () => page.waitForFunction(() => !document.querySelector('.thread-entry[data-dragging="true"]'));
    await entry(2).evaluate(node => { window.draggedRow = node; });
    const source = await begin(2);
    const point = await pointAt(4, "after");
    await page.waitForFunction(() => parseFloat(document.querySelector('.thread-entry[data-thread-id="thread-3"]').style.getPropertyValue("--thread-shift")) < 0);
    const moved = await entry(2).boundingBox();
    assert.ok(Math.abs(moved.y - point.y + 25) < 2);
    assert.equal(moved.width, source.width);
    assert.equal(await entry(2).evaluate(node => node === window.draggedRow), true);
    assert.equal(await page.locator('.thread-row-title').filter({ hasText: /^Conversation 2$/ }).count(), 1);
    assert.equal(await page.locator(".thread-drag-preview, .thread-drop-preview").count(), 0);
    await page.screenshot({ path: "/tmp/citropy-sort-desktop.png", animations: "disabled" });
    await page.mouse.up();
    await done();
    await page.waitForFunction(() => [...document.querySelectorAll('.thread-category[data-category="active"] .thread-entry')].slice(0, 3).map(node => node.dataset.threadId).join() === "thread-3,thread-4,thread-2");
    assert.deepEqual(requests.find(event => event.t === "reorder").ids.slice(0, 6), ["thread-0", "thread-1", "thread-3", "thread-4", "thread-2", "thread-5"]);
    assert.equal(await entry(2).evaluate(node => node === window.draggedRow), true);
    assert.equal(await entry(0).locator('.thread-row').getAttribute("aria-current"), "page");
    await begin(2);
    await pointAt(3, "before");
    await page.mouse.up();
    await done();
    await page.waitForFunction(() => document.querySelector('.thread-category[data-category="active"] .thread-entry')?.dataset.threadId === "thread-2");
    assert.deepEqual(requests.filter(event => event.t === "reorder").at(-1).ids.slice(0, 6), ["thread-0", "thread-1", "thread-2", "thread-3", "thread-4", "thread-5"]);
    await begin(2);
    await pointAt(1, "after");
    await page.mouse.up();
    await done();
    assert.equal(requests.filter(event => event.t === "reorder").length, 2);
    await settle();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    await cdp.send("HeapProfiler.collectGarbage");
    const listeners = async () => (await cdp.send("Performance.getMetrics")).metrics.find(item => item.name === "JSEventListeners").value;
    const baseline = await listeners();
    const resources = await page.evaluate(() => ({ observers: window.navigationResources.observers.size, frames: window.navigationResources.frames.size }));
    for (let index = 0; index < 8; index++) {
      await begin(2);
      await pointAt(4, "after");
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await done();
    }
    await settle();
    await cdp.send("HeapProfiler.collectGarbage");
    assert.equal(await listeners(), baseline);
    assert.deepEqual(await page.evaluate(() => ({ observers: window.navigationResources.observers.size, frames: window.navigationResources.frames.size })), resources);
    assert.equal(requests.filter(event => event.t === "reorder").length, 2);
    await begin(2);
    const viewport = await page.locator(".rail-list").boundingBox();
    await page.mouse.move(viewport.x + 80, viewport.y + viewport.height - 5, { steps: 8 });
    await page.waitForFunction(() => document.querySelector(".rail-list").scrollTop > 200);
    assert.equal(await entry(2).count(), 1);
    assert.ok(await page.locator(".thread-card").count() < 25);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await done();
    const stopped = await page.locator(".rail-list").evaluate(node => node.scrollTop);
    await settle();
    assert.equal(await page.locator(".rail-list").evaluate(node => node.scrollTop), stopped);
    assert.equal(await page.locator(".rail-list").evaluate(node => getComputedStyle(node).scrollbarWidth), "none");
    await page.locator(".rail-list").evaluate(node => { node.scrollTop = 0; });
    await entry(2).locator('.thread-row').click();
    assert.equal(await entry(2).locator('.thread-row').getAttribute("aria-current"), "page");
    await begin(2);
    await page.keyboard.press("Escape");
    await page.mouse.move(viewport.x + viewport.width + 50, viewport.y + 100);
    await page.mouse.up();
    await entry(3).locator('.thread-row').focus();
    await page.keyboard.press("Enter");
    assert.equal(await entry(3).locator('.thread-row').getAttribute("aria-current"), "page");
  });

  await t.test("short lists sort in narrow windows and restore their order after a failed save", async test => {
    const { page, requests } = await fixture(test, { count: 6 });
    await page.setViewportSize({ width: 600, height: 1000 });
    const entry = id => page.locator(`.thread-entry[data-thread-id="thread-${id}"]`);
    const sort = async () => {
      const source = await entry(3).boundingBox();
      await page.mouse.move(source.x + 70, source.y + 25);
      await page.mouse.down();
      await page.mouse.move(source.x + 80, source.y + 35, { steps: 5 });
      const destination = await entry(2).locator("..").boundingBox();
      await page.mouse.move(destination.x + 70, destination.y + 20, { steps: 8 });
      await page.waitForFunction(() => parseFloat(document.querySelector('.thread-entry[data-thread-id="thread-2"]').style.getPropertyValue("--thread-shift")) > 0);
    };
    await sort();
    assert.equal(await page.locator('.thread-row-title').filter({ hasText: /^Conversation 3$/ }).count(), 1);
    await page.screenshot({ path: "/tmp/citropy-sort-narrow.png", animations: "disabled" });
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('.thread-category[data-category="active"] .thread-entry')?.dataset.threadId === "thread-3");
    assert.deepEqual(requests.find(event => event.t === "reorder").ids, ["thread-0", "thread-1", "thread-3", "thread-2", "thread-4", "thread-5"]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.reload();
    await entry(2).waitFor();
    await page.route("**/api/threads/reorder?*", route => route.fulfill({ status: 500, json: { error: "Unable to save the order" } }));
    await sort();
    await page.mouse.up();
    await page.locator(".toast").filter({ hasText: "Unable to save the order" }).waitFor();
    await page.waitForFunction(() => document.querySelector('.thread-category[data-category="active"] .thread-entry')?.dataset.threadId === "thread-2");
    assert.equal(await page.locator('.thread-entry[data-dragging="true"]').count(), 0);
  });

  await t.test("dragging stops at the first and last row of its category", async test => {
    for (const { count, width } of [{ count: 3, width: 1440 }, { count: 6, width: 600 }, { count: 1000, width: 1440 }]) {
      await test.test(`${count} threads at ${width}px`, async test => {
        const { page, requests } = await fixture(test, { count });
        await page.setViewportSize({ width, height: 1000 });
        const entry = id => page.locator(`.thread-entry[data-thread-id="thread-${id}"]`);
        const id = count === 3 ? 2 : 3;
        const begin = async () => {
          const source = await entry(id).boundingBox();
          await page.mouse.move(source.x + 70, source.y + 25);
          await page.mouse.down();
          await page.mouse.move(source.x + 80, source.y + 35, { steps: 5 });
          await page.locator('.thread-entry[data-dragging="true"]').waitFor();
        };
        const first = await entry(2).locator("..").boundingBox();
        await begin();
        await page.mouse.move(first.x + 70, first.y - 80, { steps: 8 });
        await page.waitForFunction(({ id, top }) => Math.abs(document.querySelector(`[data-thread-id="thread-${id}"]`).getBoundingClientRect().top - top) < 2, { id, top: first.y });
        await page.screenshot({ path: `/tmp/citropy-drag-cap-${width}-${count}.png`, animations: "disabled" });
        await page.mouse.up();
        await page.waitForFunction(id => document.querySelector('.thread-category[data-category="active"] .thread-entry')?.dataset.threadId === `thread-${id}`, id);
        if (count === 3) assert.equal(requests.filter(event => event.t === "reorder").length, 0);
        else assert.equal(requests.filter(event => event.t === "reorder").at(-1).ids[2], `thread-${id}`);
        await begin();
        await page.locator(".rail-list").evaluate(node => { node.scrollTop = node.scrollHeight; });
        await entry(count - 1).waitFor();
        const last = await entry(count - 1).locator("..").boundingBox();
        const viewport = await page.locator(".rail-list").boundingBox();
        await page.mouse.move(last.x + 70, Math.min(viewport.y + viewport.height - 2, last.y + last.height + 80), { steps: 8 });
        await page.waitForFunction(({ id, bottom }) => {
          const node = document.querySelector(`[data-thread-id="thread-${id}"]`);
          const rect = node.getBoundingClientRect();
          return rect.bottom <= bottom + 2 && rect.bottom >= bottom - 14;
        }, { id, bottom: last.y + last.height });
        await page.mouse.up();
        await page.waitForFunction(id => [...document.querySelectorAll('.thread-category[data-category="active"] .thread-entry')].at(-1)?.dataset.threadId === `thread-${id}`, id);
        if (count === 3) assert.equal(requests.filter(event => event.t === "reorder").length, 0);
        else assert.equal(requests.filter(event => event.t === "reorder").at(-1).ids.at(-1), `thread-${id}`);
        if (count === 1000) {
          await page.locator(".rail-list").evaluate(node => { node.scrollTop = 0; });
          await entry(0).waitFor();
          const pinned = await entry(0).boundingBox();
          const limit = await entry(1).locator("..").boundingBox();
          await page.mouse.move(pinned.x + 70, pinned.y + 25);
          await page.mouse.down();
          await page.mouse.move(viewport.x + 70, viewport.y + viewport.height - 2, { steps: 8 });
          await page.waitForFunction(bottom => document.querySelector('[data-thread-id="thread-0"]').getBoundingClientRect().bottom <= bottom + 2, limit.y + limit.height);
          await page.evaluate(() => new Promise(resolve => {
            let count = 12;
            const frame = () => --count > 0 ? requestAnimationFrame(frame) : resolve();
            requestAnimationFrame(frame);
          }));
          assert.equal(await page.locator(".rail-list").evaluate(node => node.scrollTop), 0);
          await page.mouse.up();
          await page.waitForFunction(() => document.querySelector('.thread-category[data-category="pinned"] .thread-entry')?.dataset.threadId === "thread-1");
          assert.deepEqual(requests.filter(event => event.t === "reorder").at(-1).ids.slice(0, 2), ["thread-1", "thread-0"]);
        }
      });
    }
  });

  await t.test("opening and closing repeatedly does not accumulate nodes, listeners, or animation frames", async (test) => {
    const { page, settle } = await fixture(test);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const cycle = async () => {
      await page.getByRole("button", { name: "Choose workspace, Example workspace", exact: true }).click();
      await page.getByRole("menu").waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("menu").waitFor({ state: "detached" });
      await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
      await page.locator(".thread-card").first().waitFor({ state: "detached" });
      await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
      await page.locator(".thread-card").first().waitFor();
      await settle();
    };
    await cycle();
    await cdp.send("HeapProfiler.collectGarbage");
    const before = (await cdp.send("Performance.getMetrics")).metrics;
    const resources = await page.evaluate(() => ({ observers: window.navigationResources.observers.size, frames: window.navigationResources.frames.size }));
    for (let index = 0; index < 20; index++) await cycle();
    await cdp.send("HeapProfiler.collectGarbage");
    const after = (await cdp.send("Performance.getMetrics")).metrics;
    const value = (metrics, name) => metrics.find((metric) => metric.name === name).value;
    test.diagnostic(JSON.stringify({ before: before.filter((item) => ["Nodes", "JSEventListeners", "JSHeapUsedSize"].includes(item.name)), after: after.filter((item) => ["Nodes", "JSEventListeners", "JSHeapUsedSize"].includes(item.name)) }));
    assert.ok(value(after, "Nodes") <= value(before, "Nodes") + 100);
    assert.ok(value(after, "JSEventListeners") <= value(before, "JSEventListeners") + 5);
    assert.ok(value(after, "JSHeapUsedSize") < value(before, "JSHeapUsedSize") * 1.3 + 2_000_000);
    assert.deepEqual(await page.evaluate(() => ({ observers: window.navigationResources.observers.size, frames: window.navigationResources.frames.size })), resources);
    await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
    assert.equal(await page.locator('.sliding-panel[data-side="left"]').getAttribute("inert"), "");
    await page.locator(".thread-card").first().waitFor({ state: "detached" });
    assert.equal(await page.getByRole("button", { name: "New thread", exact: true }).count(), 0);
  });

  await t.test("panels reverse cleanly, fit narrow windows, and honor changes to reduced motion", async (test) => {
    const { page, settle } = await fixture(test);
    const toggle = page.getByRole("button", { name: "Toggle inspector", exact: true });
    await toggle.click();
    await page.getByRole("tab", { name: "Changes", exact: true }).waitFor();
    await settle();
    const panel = page.locator('.sliding-panel[data-side="right"]');
    await toggle.evaluate((button) => button.click());
    await page.waitForFunction(() => document.querySelector('.sliding-panel[data-side="right"]').getAnimations().length > 0);
    await toggle.evaluate((button) => button.click());
    await settle();
    assert.equal(await panel.getAttribute("hidden"), null);
    assert.equal(await panel.getAttribute("inert"), null);
    for (const [width, scale] of [[1440, 120], [600, 120], [480, 150]]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(async (value) => (await import("/web/src/lib/store.ts")).setUiScale(value), scale);
      await settle();
      for (const selector of ['.sliding-panel[data-side="left"] .rail', '.sliding-panel[data-side="right"] .inspector']) {
        const box = await page.locator(selector).boundingBox();
        assert.ok(box.x >= -1 && box.x + box.width <= width + 1);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: `/tmp/citropy-motion-${width}-${scale}.png`, animations: "disabled" });
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(() => document.querySelector('.sliding-panel[data-side="right"]').style.getPropertyValue("--panel-duration") === "0ms");
    await toggle.click();
    await panel.waitFor({ state: "hidden" });
    await toggle.click();
    await settle();
    assert.equal(await panel.evaluate((node) => node.getAnimations().length), 0);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.waitForFunction(() => document.querySelector('.sliding-panel[data-side="right"]').style.getPropertyValue("--panel-duration") === "200ms");
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    assert.equal(await page.locator("html").getAttribute("data-page-hidden"), "");
    assert.equal(await page.locator(".rail").evaluate((node) => getComputedStyle(node).animationPlayState), "paused");
  });

  await t.test("selection highlights slide, follow resizing, and release their observer", async test => {
    const { page, settle } = await fixture(test, { count: 6 });
    await page.evaluate(async () => {
      const { useApp } = await import("/web/src/lib/store.ts");
      useApp.setState({ inspectorOpen: true, activePanels: { workspace: "changes" }, panels: ["changes", "tools", "subagents"].map(kind => ({ id: kind, kind, projectId: "workspace", title: kind[0].toUpperCase() + kind.slice(1) })) });
    });
    const strip = page.getByRole("tablist", { name: "Open workspace panels", exact: true });
    const pill = strip.locator(".selection-highlight");
    await strip.waitFor();
    await settle();
    const aligned = async () => {
      const bounds = await strip.evaluate(node => {
        const pill = node.querySelector(".selection-highlight");
        const active = node.querySelector('.workbench-tab[data-active="true"]');
        return { hidden: pill.hidden, pill: pill.getBoundingClientRect().toJSON(), active: active.getBoundingClientRect().toJSON() };
      });
      assert.equal(bounds.hidden, false);
      for (const key of ["x", "y", "width", "height"]) assert.ok(Math.abs(bounds.pill[key] - bounds.active[key]) < 1.6, JSON.stringify(bounds));
    };
    await aligned();
    assert.equal(await pill.evaluate(node => node.getAnimations().length), 0);
    for (const name of ["Tools", "Changes", "Subagents"]) {
      await strip.getByRole("tab", { name, exact: true }).evaluate(node => node.click());
      await page.waitForFunction(() => document.querySelector(".workbench-tabs .selection-highlight").getAnimations().some(animation => animation.playState === "running" && animation.currentTime >= 32));
    }
    await settle();
    await aligned();
    for (const [width, scale] of [[1440, 90], [620, 150], [1440, 120]]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(async scale => (await import("/web/src/lib/store.ts")).setUiScale(scale), scale);
      await settle();
      await aligned();
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await strip.getByRole("tab", { name: "Changes", exact: true }).click();
    await aligned();
    assert.equal(await pill.evaluate(node => node.getAnimations().length), 0);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const navigation = page.locator(".section-nav");
    await navigation.waitFor();
    await settle();
    assert.equal(await navigation.locator(".selection-highlight").evaluate(node => node.hidden), false);
    await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    await navigation.waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => [...window.navigationResources.observers].some(observer => [...observer.targets].some(node => !node.isConnected))), false);
  });

  await t.test("the thinking timer sleeps while hidden and resumes from the original start time", async (test) => {
    const { page } = await fixture(test);
    await page.clock.install();
    await page.evaluate(async () => {
      const { useApp } = await import("/web/src/lib/store.ts");
      useApp.setState((state) => ({ threads: { ...state.threads, "thread-0": { ...state.threads["thread-0"], running: true, status: "thinking", runStartedAt: Date.now() - 65_000 } } }));
    });
    await page.locator(".working-time").waitFor();
    await page.evaluate(() => {
      window.timerChanges = 0;
      window.timerObserver = new MutationObserver(() => { window.timerChanges++; });
      window.timerObserver.observe(document.querySelector(".working-time"), { characterData: true, subtree: true });
    });
    await page.clock.runFor(5000);
    assert.ok(await page.evaluate(() => window.timerChanges) <= 6);
    const before = await page.locator(".working-time").textContent();
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.clock.runFor(5000);
    assert.equal(await page.locator(".working-time").textContent(), before);
    await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event("visibilitychange"));
      window.timerObserver.disconnect();
    });
    assert.match(await page.locator(".working-time").textContent(), /^1m 1[5-7]s$/);
  });
});
