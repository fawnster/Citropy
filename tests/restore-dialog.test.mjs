import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

test("restore choices stay clickable, explain unavailable files and preserve keyboard navigation", { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-restore-ui-"));
  const server = await createServer({ configFile: false, cacheDir: join(directory, "cache"), root: fileURLToPath(new URL("..", import.meta.url)), plugins: [react()], server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await rm(directory, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(20000);
  const errors = [];
  const requests = [];
  let connection;
  const thread = { id: "chat", projectId: "project", provider: "claude", model: "example", title: "Improve request handling", createdAt: 1, updatedAt: 1, running: false, status: "idle", permissionMode: "manual", checkpoints: [{ messageId: "prompt", before: "before", createdAt: 1 }, { messageId: "later", before: "middle", after: "after", createdAt: 2 }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, turns: 0 } };
  const messages = [{ id: "prompt", role: "user", ts: 1, parts: [{ id: "question", kind: "text", text: "Improve request handling." }] }, { id: "answer", role: "assistant", ts: 2, parts: [{ id: "reply", kind: "text", text: "The request handler now reports failures.", complete: true }] }];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => { for (const [key, value] of Object.entries({ project: "project", thread: "chat", inspector: "0", theme: "dark", uiScale: "100" })) localStorage.setItem(`citropy.${key}`, value); });
  await page.routeWebSocket("**/socket*", socket => {
    connection = socket;
    socket.onMessage(raw => {
      if (JSON.parse(raw).t === "thread.load") socket.send(JSON.stringify({ t: "thread.messages", threadId: "chat", messages }));
    });
    socket.send(JSON.stringify({ t: "hello", snapshot: { projects: [{ id: "project", path: "/example", name: "Product workspace", isGit: true, lastOpened: 1 }], threads: [thread], providers: [{ id: "claude", label: "Claude Code", available: true, enabled: true, supportsPermissionPrompt: true, models: [{ id: "example", label: "Example model" }] }], permissions: [], home: "/example" } }));
  });
  await page.route("**/api/**", route => {
    if (new URL(route.request().url()).pathname === "/api/threads/restore") {
      requests.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByText("The request handler now reports failures.", { exact: true }).waitFor();
  const trigger = page.getByRole("button", { name: "Restore before this message", exact: true });
  const dialog = page.getByRole("dialog", { name: "Restore before this message", exact: true });
  await page.locator("#message-prompt .turn-heading").hover();
  await trigger.click();
  assert.equal(await dialog.getByRole("combobox").count(), 0);
  for (const name of ["Files only", "Files and conversation", "Conversation only"]) {
    const choice = dialog.getByRole("radio", { name, exact: true });
    const bounds = await choice.locator("..").boundingBox();
    await page.mouse.click(bounds.x + 8, bounds.y + bounds.height / 2);
    assert.equal(await choice.isChecked(), true, name);
  }
  await dialog.getByRole("radio", { name: "Conversation only", exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await dialog.getByRole("radio", { name: "Files only", exact: true }).isChecked(), true);
  await page.keyboard.press("ArrowDown");
  assert.equal(await dialog.getByRole("radio", { name: "Files and conversation", exact: true }).isChecked(), true);
  await page.screenshot({ path: "/tmp/citropy-restore-desktop.png", animations: "disabled" });
  await page.setViewportSize({ width: 420, height: 720 });
  const bounds = await dialog.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 420 && bounds.y >= 0 && bounds.y + bounds.height <= 720, JSON.stringify(bounds));
  assert.ok(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
  await page.screenshot({ path: "/tmp/citropy-restore-narrow.png", animations: "disabled" });
  await dialog.getByRole("button", { name: "Restore", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(requests, [{ messageId: "prompt", mode: "both" }]);
  const scrim = page.getByRole("button", { name: "Close navigation", exact: true });
  if (await scrim.isVisible()) {
    const area = await scrim.boundingBox();
    await scrim.click({ position: { x: area.width - 8, y: area.height / 2 } });
  }
  connection.send(JSON.stringify({ t: "thread.upsert", thread: { ...thread, checkpoints: [] } }));
  await page.locator("#message-prompt .turn-heading").hover();
  await trigger.click();
  await dialog.getByText("No file checkpoint was saved for this message.", { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("radio", { name: "Files only", exact: true }).isDisabled(), true);
  connection.send(JSON.stringify({ t: "thread.upsert", thread: { ...thread, checkpoints: [{ messageId: "prompt", before: "before", after: "first-after", createdAt: 1 }, { messageId: "later", before: "middle", createdAt: 2 }] } }));
  await dialog.getByText("No completed file checkpoint is available for this task yet.", { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("radio", { name: "Files only", exact: true }).isDisabled(), true);
  assert.equal(await dialog.getByRole("radio", { name: "Files and conversation", exact: true }).isDisabled(), true);
  assert.equal(await dialog.getByRole("radio", { name: "Conversation only", exact: true }).isEnabled(), true);
  await page.screenshot({ path: "/tmp/citropy-restore-unavailable.png", animations: "disabled" });
  connection.send(JSON.stringify({ t: "thread.upsert", thread: { ...thread, checkpoints: [...thread.checkpoints, { messageId: "shared", before: "before-shared", after: "after-shared", createdAt: 3, overlapping: true }] } }));
  await dialog.getByText("Another task worked in this folder. Only conversation history can be restored.", { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("radio", { name: "Files only", exact: true }).isDisabled(), true);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (let index = 0; index < 4; index++) {
    await page.locator("#message-prompt .turn-heading").hover();
    await trigger.click();
    await dialog.waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
  }
  assert.equal(await page.locator("dialog[open]").count(), 0);
  assert.deepEqual(errors, []);
});
