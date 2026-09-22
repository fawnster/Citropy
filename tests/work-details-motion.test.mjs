import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

test("work details transitions preserve virtualized layout and interaction", { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-work-motion-"));
  let server, browser;
  t.after(async () => {
    await browser?.close();
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  });
  server = await createServer({
    configFile: false, root: fileURLToPath(new URL("..", import.meta.url)),
    cacheDir: join(directory, "cache"), plugins: [react()], logLevel: "error",
    server: { host: "127.0.0.1", port: 0, watch: null },
  });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" });
  page.setDefaultTimeout(10000);
  const errors = [];
  let publish;
  page.on("pageerror", error => errors.push(error.message));
  const project = { id: "workspace", name: "Workspace", path: "/example", isGit: false, lastOpened: 1 };
  const thread = { id: "chat", projectId: project.id, provider: "claude", model: "sample", title: "Work details", permissionMode: "manual", createdAt: 1, updatedAt: 1, status: "idle", running: false,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, contextTokens: 0, contextMax: 200000, turns: 0 },
  };
  const parts = Array.from({ length: 120 }, (_, index) => [
    { id: `thought-${index}`, kind: "reasoning", text: `Inspect section ${index}.`, complete: true },
    { id: `tool-${index}`, kind: "tool", callId: `tool-${index}`, name: "Read", shape: "read", headline: `section-${index}.txt`, input: {}, status: "ok", startedAt: 1, endedAt: 2 },
  ]).flat();
  parts.push({ id: "answer", kind: "text", text: "All sections are ready.", complete: true });
  await page.addInitScript(() => {
    for (const [key, value] of Object.entries({ project: "workspace", thread: "chat", inspector: "0", sidebar: "0", theme: "dark", textStreaming: "0", typingAnimation: "0" })) localStorage.setItem(`citropy.${key}`, value);
  });
  await page.routeWebSocket("**/socket", socket => {
    publish = event => socket.send(JSON.stringify(event));
    socket.onMessage(raw => {
      const event = JSON.parse(raw);
      if (event.t === "thread.load") socket.send(JSON.stringify({ t: "thread.messages", threadId: "chat", messages: [{ id: "response", role: "assistant", ts: 1, parts }] }));
      if (event.t === "github.request") socket.send(JSON.stringify({ t: "github.result", requestId: event.requestId, result: { installed: false, repositories: [] } }));
    });
    socket.send(JSON.stringify({ t: "hello", snapshot: { projects: [project], threads: [thread], providers: [{ id: "claude", label: "Claude Code", available: true, enabled: true, models: [{ id: "sample", label: "Example model" }] }], permissions: [], home: "/example" } }));
  });
  await page.goto(server.resolvedUrls.local[0]);
  const details = page.getByRole("button", { name: "Work details", exact: true });
  await details.waitFor();
  await page.locator('[data-part-id="answer"]').waitFor();
  await page.evaluate(() => {
    window.workAnimations = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const animation = animate.apply(this, args);
      if (this.matches(".timeline-row")) {
        window.workAnimations.push(animation);
        if (window.pauseWorkAnimations) {
          animation.pause();
          animation.currentTime = 0;
        }
      }
      return animation;
    };
  });
  const settled = () => page.evaluate(async () => {
    await Promise.allSettled(window.workAnimations.filter(animation => animation.playState !== "idle").map(animation => animation.finished));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });

  await t.test("opening and closing stay scoped, windowed and keyboard accessible", async () => {
    await details.focus();
    await details.press("Enter");
    await page.locator('.activity-head[aria-expanded="true"]').waitFor();
    assert.ok(await page.evaluate(() => window.workAnimations.length > 0));
    assert.equal(await page.evaluate(() => window.workAnimations.some(animation =>
      animation.effect.target.querySelector('.turn-heading, .activity-head, [data-part-id="answer"]'),
    )), false, "Opening work details must not fade the existing message header, summary or answer");
    await settled();
    assert.ok(await page.locator(".timeline-row").count() < 40);
    assert.equal(await details.evaluate(element => element === document.activeElement), true);
    await page.screenshot({ path: "/tmp/citropy-work-motion-open.png" });
    const animationsBeforeClose = await page.evaluate(() => window.workAnimations.length);
    await details.press("Space");
    await settled();
    assert.equal(await page.evaluate(() => window.workAnimations.length), animationsBeforeClose, "Closing must not fade the surviving rows");
    assert.equal(await details.getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator(".timeline-row").count(), 2);
    assert.equal(await details.evaluate(element => element === document.activeElement), true);
    const gap = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".timeline-row")].map(element => element.getBoundingClientRect()).sort((a, b) => a.top - b.top);
      return rows[1].top - rows[0].bottom;
    });
    assert.ok(Math.abs(gap) < 2, `Collapsed rows left a ${gap}px gap`);
  });

  await t.test("rapid reversal applies every toggle without trapping pointer input", async () => {
    await details.dblclick({ delay: 40 });
    await settled();
    assert.equal(await details.getAttribute("aria-expanded"), "false");
    await details.evaluate(element => { element.click(); element.click(); });
    await settled();
    assert.equal(await details.getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator(".timeline-row").count(), 2);
  });

  await t.test("narrow layouts do not overflow or retain closing rows", async () => {
    await page.setViewportSize({ width: 600, height: 900 });
    await details.click();
    await settled();
    assert.ok(await page.locator(".timeline-row").count() < 40);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: "/tmp/citropy-work-motion-narrow.png" });
    await details.click();
    await settled();
    assert.equal(await page.locator(".timeline-row").count(), 2);
  });

  await t.test("reduced motion updates without an animation", async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    const before = await page.evaluate(() => window.workAnimations.length);
    await details.click();
    assert.equal(await details.getAttribute("aria-expanded"), "true");
    await details.click();
    assert.equal(await details.getAttribute("aria-expanded"), "false");
    assert.equal(await page.evaluate(() => window.workAnimations.length), before);
  });

  await t.test("headers, summaries and answers stay fully visible while newly revealed work enters", async () => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    publish({ t: "thread.messages", threadId: "chat", messages: [{ id: "response", role: "assistant", ts: 1, parts: [...parts.slice(0, 4), parts.at(-1)] }] });
    await page.locator(".activity-count").getByText("2 tools", { exact: true }).waitFor();
    for (const width of [1440, 420]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => {
        window.workAnimations = [];
        window.pauseWorkAnimations = true;
        window.stableMessageElements = [document.querySelector(".turn-heading"), document.querySelector(".activity-head"), document.querySelector('[data-part-id="answer"]')];
      });
      await details.click();
      const opening = await page.evaluate(() => ({
        opacity: window.stableMessageElements.map(element => getComputedStyle(element.closest(".timeline-row")).opacity),
        retained: window.stableMessageElements.every(element => element.isConnected),
        targetsAreNew: window.workAnimations.every(animation => !window.stableMessageElements.some(element => animation.effect.target.contains(element))),
        animated: window.workAnimations.length,
      }));
      assert.deepEqual(opening.opacity, ["1", "1", "1"]);
      assert.equal(opening.retained, true);
      assert.equal(opening.targetsAreNew, true);
      assert.ok(opening.animated > 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: `/tmp/citropy-work-details-no-flicker-${width}-opening.png`, animations: "allow" });
      await details.click();
      await settled();
      assert.equal(await page.evaluate(() => window.workAnimations.length), opening.animated);
      assert.deepEqual(await page.evaluate(() => window.stableMessageElements.map(element => getComputedStyle(element.closest(".timeline-row")).opacity)), ["1", "1", "1"]);
      assert.equal(await page.locator(".timeline-row").count(), 2);
      await page.screenshot({ path: `/tmp/citropy-work-details-no-flicker-${width}-closed.png`, animations: "allow" });
    }
  });
  assert.deepEqual(errors, []);
});
