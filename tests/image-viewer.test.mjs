import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

test("image previews and viewer navigation", { timeout: 45000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-image-viewer-"));
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const project = { id: "workspace", name: "Workspace", path: "/example", isGit: false, lastOpened: 1 };
  const thread = { id: "chat", projectId: project.id, provider: "claude", model: "sample", title: "Preview images", permissionMode: "manual", createdAt: 1, updatedAt: 1, status: "idle", running: false,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, contextTokens: 0, contextMax: 200000, turns: 0 },
  };
  const files = [
    { path: "/landscape.png", label: "Landscape preview" },
    { path: "/portrait.png", label: "Portrait preview" },
    { path: "/missing.png", label: "Missing preview" },
    { path: "/final.png", label: "Final preview" },
  ];
  const attachments = [
    { ...files[0], id: "first", mime: "image/png" },
    { path: "/notes.txt", label: "Notes", id: "notes", mime: "text/plain" },
    { ...files[1], id: "second", mime: "image/png" },
  ];
  const parts = [
    { id: "image-tool", kind: "tool", callId: "image-tool", name: "GenerateImage", shape: "generic", headline: "Created image previews", input: {}, output: "Four image previews are ready.", imageFiles: files, status: "ok", startedAt: 1, endedAt: 2 },
    { id: "answer", kind: "text", text: "Select an image to see it at full size.", complete: true },
    { id: "gallery", kind: "images", files },
  ];
  await page.addInitScript(() => {
    for (const [key, value] of Object.entries({ project: "workspace", thread: "chat", inspector: "0", sidebar: "0", uiScale: "100", theme: "dark", textStreaming: "0", typingAnimation: "0" })) localStorage.setItem(`citropy.${key}`, value);
  });
  await page.route("**/api/assets?**", route => {
    const path = new URL(route.request().url()).searchParams.get("path");
    if (path === "/missing.png") return route.fulfill({ status: 404, body: "" });
    const portrait = path === "/portrait.png";
    const width = portrait ? 1200 : 3200;
    const height = portrait ? 2400 : 1800;
    return route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${portrait ? "#8d7050" : "#365447"}"/><circle cx="${width / 2}" cy="${height / 2}" r="${width / 4}" fill="${portrait ? "#dcb781" : "#a4c4a7"}"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="${width / 20}" fill="#152b22">${portrait ? "Portrait" : "Landscape"}</text></svg>` });
  });
  await page.routeWebSocket("**/socket", socket => {
    socket.onMessage(raw => {
      const event = JSON.parse(raw);
      if (event.t === "thread.load") socket.send(JSON.stringify({ t: "thread.messages", threadId: "chat", messages: [
        { id: "question", role: "user", ts: 1, parts: [{ id: "prompt", kind: "text", text: "Show the image previews." }], attachments },
        { id: "response", role: "assistant", ts: 2, parts },
      ] }));
      if (event.t === "github.request") socket.send(JSON.stringify({ t: "github.result", requestId: event.requestId, result: { installed: false, repositories: [] } }));
    });
    socket.send(JSON.stringify({ t: "hello", snapshot: { projects: [project], threads: [thread], providers: [{ id: "claude", label: "Claude Code", available: true, enabled: true, models: [{ id: "sample", label: "Example model" }] }], permissions: [], home: "/example" } }));
  });
  await page.goto(server.resolvedUrls.local[0]);
  const gallery = page.locator(".image-gallery");
  await gallery.getByRole("button", { name: "Preview Landscape preview", exact: true }).waitFor();
  const viewer = page.locator(".image-viewer");
  const ready = async name => {
    await viewer.getByRole("heading", { name, exact: true }).waitFor();
    await page.waitForFunction(() => {
      const image = document.querySelector(".image-viewer img");
      return image?.naturalWidth > 0 && image.style.visibility !== "hidden";
    });
  };

  await t.test("side controls and keyboard arrows preserve the dialog and reset image state", async t => {
    t.after(async () => { await page.keyboard.press("Escape"); });
    const trigger = gallery.getByRole("button", { name: "Preview Landscape preview", exact: true });
    await trigger.click();
    await ready("Landscape preview");
    await viewer.evaluate(element => { element.dataset.identity = "original"; });
    assert.equal(await viewer.getByRole("button", { name: "Previous image", exact: true }).isDisabled(), true);
    await viewer.getByRole("status", { name: "Image 1 of 4", exact: true }).waitFor();
    const fit = await viewer.getByRole("button", { name: "Fit image", exact: true }).textContent();
    await viewer.getByRole("button", { name: "Zoom in", exact: true }).click();
    assert.notEqual(await viewer.getByRole("button", { name: "Fit image", exact: true }).textContent(), fit);
    await viewer.getByRole("button", { name: "Fit image", exact: true }).click();
    await viewer.locator("img").dblclick();
    assert.equal(await viewer.getByRole("button", { name: "Fit image", exact: true }).textContent(), "100%");
    await viewer.locator(".image-viewport").evaluate(element => { element.scrollTop = 200; element.scrollLeft = 200; });
    await viewer.getByRole("button", { name: "Next image", exact: true }).click();
    await ready("Portrait preview");
    assert.equal(await viewer.getAttribute("data-identity"), "original");
    assert.notEqual(await viewer.getByRole("button", { name: "Fit image", exact: true }).textContent(), "100%");
    assert.deepEqual(await viewer.locator(".image-viewport").evaluate(element => [element.scrollLeft, element.scrollTop]), [0, 0]);
    const download = new URL(await viewer.getByRole("link", { name: "Download image", exact: true }).getAttribute("href"));
    assert.equal(download.searchParams.get("path"), "/portrait.png");
    assert.equal(download.searchParams.get("download"), "1");
    await page.keyboard.press("ArrowRight");
    await viewer.getByRole("alert").getByText("Unable to load this image.", { exact: true }).waitFor();
    assert.equal(await viewer.getByRole("link", { name: "Download image", exact: true }).count(), 0);
    await page.keyboard.press("ArrowRight");
    await ready("Final preview");
    assert.equal(await viewer.getByRole("button", { name: "Next image", exact: true }).isDisabled(), true);
    await page.keyboard.press("ArrowRight");
    await viewer.getByRole("status", { name: "Image 4 of 4", exact: true }).waitFor();
    await page.keyboard.press("ArrowLeft");
    await viewer.getByRole("alert").waitFor();
    await viewer.getByRole("button", { name: "Previous image", exact: true }).click();
    await ready("Portrait preview");
    await page.screenshot({ path: "/tmp/citropy-image-viewer-1440.png" });
    await viewer.getByRole("button", { name: "Zoom in", exact: true }).click();
    await page.keyboard.press("ArrowRight");
    await viewer.getByRole("alert").waitFor();
    await page.keyboard.press("ArrowRight");
    await ready("Final preview");
    await page.keyboard.press("Escape");
    await viewer.waitFor({ state: "detached" });
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
  });

  await t.test("tool previews stay bounded and missing images remain understandable", async () => {
    await gallery.getByRole("img", { name: "Image unavailable", exact: true }).waitFor();
    await page.getByRole("button", { name: "Work details", exact: true }).click();
    const tool = page.locator("#tool-image-tool");
    await tool.locator(".tool-head").click();
    await tool.getByRole("img", { name: "Image unavailable", exact: true }).waitFor();
    for (const width of [1440, 420]) {
      await page.setViewportSize({ width, height: 900 });
      await tool.locator(".image-strip").scrollIntoViewIfNeeded();
      const bounds = await tool.locator(".image-strip img").evaluateAll(images => images.map(image => ({ width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height })));
      assert.ok(bounds.every(image => image.width > 0 && image.width <= 320 && image.height > 0 && image.height <= 240), JSON.stringify(bounds));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: `/tmp/citropy-image-previews-${width}.png` });
    }
    await tool.getByRole("button", { name: "Preview Portrait preview", exact: true }).click();
    await ready("Portrait preview");
    await viewer.getByRole("status", { name: "Image 2 of 4", exact: true }).waitFor();
    const boxes = await viewer.locator(".image-navigation, .image-viewport").evaluateAll(elements => elements.map(element => { const bounds = element.getBoundingClientRect(); return { left: bounds.left, right: bounds.right, width: bounds.width }; }));
    assert.ok(boxes[0].width >= 44 && boxes[2].width >= 44 && boxes[0].right <= boxes[1].left && boxes[1].right <= boxes[2].left && boxes[2].right <= 420, JSON.stringify(boxes));
    assert.equal(await viewer.evaluate(element => element.scrollWidth > element.clientWidth), false);
    await page.screenshot({ path: "/tmp/citropy-image-viewer-420.png" });
    await page.keyboard.press("Escape");
    await viewer.waitFor({ state: "detached" });
  });

  await t.test("attachment navigation excludes non-image files", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const trigger = page.locator(".attachments").getByRole("button", { name: "Preview Landscape preview", exact: true });
    await trigger.click();
    await ready("Landscape preview");
    await viewer.getByRole("status", { name: "Image 1 of 2", exact: true }).waitFor();
    await viewer.getByRole("button", { name: "Next image", exact: true }).click();
    await ready("Portrait preview");
    await viewer.getByRole("status", { name: "Image 2 of 2", exact: true }).waitFor();
    await page.keyboard.press("ArrowLeft");
    await ready("Landscape preview");
    await page.keyboard.press("Escape");
    await viewer.waitFor({ state: "detached" });
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
  });
  assert.deepEqual(errors, []);
});
