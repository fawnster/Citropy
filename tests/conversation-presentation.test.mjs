import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

const thread = {
  id: "chat", projectId: "workspace", provider: "claude", model: "sample", title: "Presentation check",
  permissionMode: "manual", createdAt: 1, updatedAt: 1, status: "idle", running: false,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, contextTokens: 0, contextMax: 200000, turns: 0 },
};
const textPart = (id, text, complete = true) => ({ id, kind: "text", text, complete });
const message = (id, parts) => ({ id, role: "assistant", ts: 1, parts });
const tools = Array.from({ length: 3 }, (_, index) => ({
  id: `tool-${index}`, kind: "tool", callId: `call-${index}`, name: "Read", shape: "read",
  headline: `file-${index}.txt`, input: {}, status: "ok", startedAt: 1, endedAt: 100,
  output: "Example file contents.",
}));

test("conversation presentation", { timeout: 90_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-presentation-"));
  let server;
  let browser;
  t.after(async () => {
    await browser?.close();
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  });
  server = await createServer({
    configFile: false, cacheDir: join(directory, "node_modules", ".vite"),
    root: fileURLToPath(new URL("..", import.meta.url)), plugins: [react()], logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  async function fixture({ preferences = {}, messages = [message("saved", [textPart("saved-text", "Saved conversation.")])], children = [], reducedMotion = "no-preference" } = {}) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion });
    page.setDefaultTimeout(10000);
    const errors = [];
    const requests = [];
    let connection;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((preferences) => {
      for (const [key, value] of Object.entries({ project: "workspace", thread: "chat", inspector: "0", theme: "dark", uiScale: "120", ...preferences }))
        localStorage.setItem(`citropy.${key}`, value);
      const request = window.requestAnimationFrame;
      const cancel = window.cancelAnimationFrame;
      const frames = new Set();
      window.presentationFrames = frames;
      window.requestAnimationFrame = (callback) => {
        const id = request((time) => { frames.delete(id); callback(time); });
        frames.add(id);
        return id;
      };
      window.cancelAnimationFrame = (id) => { frames.delete(id); cancel(id); };
    }, preferences);
    await page.routeWebSocket("**/socket", (socket) => {
      connection = socket;
      socket.onMessage((raw) => {
        const event = JSON.parse(raw);
        requests.push(event);
        if (event.t === "thread.send") socket.send(JSON.stringify({ t: "thread.accepted", requestId: event.requestId }));
        if (event.t === "thread.load") socket.send(JSON.stringify({ t: "thread.messages", threadId: event.id, messages: event.id === "chat" ? messages : [message(`${event.id}-message`, [textPart(`${event.id}-text`, "Subagent result.")])] }));
      });
      socket.send(JSON.stringify({ t: "hello", snapshot: {
        projects: [{ id: "workspace", name: "Example workspace", path: "/example", isGit: false, lastOpened: 1 }],
        threads: [thread, ...children], providers: [{ id: "claude", label: "Claude Code", available: true, enabled: true, models: [{ id: "sample", label: "Example model" }] }], permissions: [], home: "/example",
      } }));
    });
    await page.goto(server.resolvedUrls.local[0]);
    try {
      await page.locator(".turn").first().waitFor({ timeout: 7000 });
    } catch (error) {
      throw new Error(JSON.stringify({ errors, body: await page.locator("body").innerText() }), { cause: error });
    }
    const emit = (...events) => events.forEach((event) => connection.send(JSON.stringify(event)));
    const begin = (id, text) => emit(
      { t: "thread.upsert", thread: { ...thread, running: true, status: "working" } },
      { t: "message.add", threadId: "chat", message: message(id, [textPart(`${id}-text`, text, false)]) },
    );
    const complete = (id) => emit({ t: "part.patch", threadId: "chat", messageId: id, partId: `${id}-text`, patch: { complete: true } });
    const idle = () => emit({ t: "thread.upsert", thread });
    return { page, emit, begin, complete, idle, requests, close: async () => { assert.deepEqual(errors, []); await page.close(); } };
  }

  await t.test("streaming displays arriving text and buffering waits for the completed block", async () => {
    for (const streaming of ["1", "0"]) {
      const f = await fixture({ preferences: { textStreaming: streaming } });
      f.begin("response", "The first words");
      await f.page.locator("#message-response").waitFor();
      if (streaming === "1") await f.page.locator('[data-part-id="response-text"]').getByText("The first words", { exact: true }).waitFor();
      else assert.equal(await f.page.locator('[data-part-id="response-text"]').count(), 0);
      f.emit({ t: "part.append", threadId: "chat", messageId: "response", partId: "response-text", text: " are now complete." });
      f.complete("response");
      await f.page.locator('[data-part-id="response-text"]').getByText("The first words are now complete.", { exact: true }).waitFor();
      assert.equal(await f.page.locator('[data-part-id="response-text"][aria-busy="true"]').count(), 0);
      f.idle();
      await f.close();
    }
  });

  await t.test("typing reveals finished Markdown at the selected speed without replaying history", async () => {
    const f = await fixture({ preferences: { textStreaming: "0", typingAnimation: "1", typingSpeed: "20" } });
    const { page } = f;
    assert.equal(await page.locator('[data-part-id="saved-text"]').textContent(), "Saved conversation.\n");
    assert.equal(await page.locator('[aria-busy="true"]').count(), 0);
    const richText = "A **formatted** answer with a [link](https://example.com).\n\n```js\nconst answer = 42;\n```";
    f.begin("reveal", richText);
    await page.locator("#message-reveal").waitFor();
    f.complete("reveal");
    f.idle();
    const prose = page.locator('[data-part-id="reveal-text"]');
    await prose.locator("strong").waitFor({ state: "attached" });
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-part-id="reveal-text"]');
      return node?.getAttribute("aria-busy") === "true" && node.textContent.length > 3;
    });
    const partial = await prose.textContent();
    assert.ok(partial.length < 40, partial);
    assert.ok(!partial.includes("**") && !partial.includes("```"));
    await page.waitForFunction(() => document.querySelector('[data-part-id="reveal-text"]')?.getAttribute("aria-busy") !== "true");
    assert.equal(await prose.locator("strong").textContent(), "formatted");
    assert.equal(await prose.locator("a").getAttribute("href"), "https://example.com");
    assert.equal((await prose.locator("code").textContent()).trim(), "const answer = 42;");
    assert.equal(await prose.locator("[data-reveal-hidden]").count(), 0);
    await page.evaluate(async () => (await import("/web/src/lib/store.ts")).setTypingSpeed(300));
    const started = Date.now();
    f.begin("fast", "A".repeat(150));
    f.complete("fast");
    f.idle();
    await page.waitForFunction(() => document.querySelector('[data-part-id="fast-text"]')?.textContent.trim().length === 150);
    assert.ok(Date.now() - started < 2500);
    await page.evaluate(async () => (await import("/web/src/lib/store.ts")).setTypingSpeed(20));
    f.begin("cancel", "A".repeat(1000));
    f.complete("cancel");
    f.idle();
    await page.locator('[data-part-id="cancel-text"][aria-busy="true"]').waitFor();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Back to chat", exact: true }).waitFor();
    await page.waitForFunction(() => window.presentationFrames.size === 0);
    await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    await page.locator('[data-part-id="cancel-text"]').waitFor();
    assert.equal(await page.locator('[data-part-id="cancel-text"][aria-busy="true"]').count(), 0);
    assert.equal((await page.locator('[data-part-id="cancel-text"]').textContent()).trim().length, 1000);
    await f.close();
  });

  await t.test("reduced motion bypasses typing and interrupted output remains readable", async () => {
    const f = await fixture({ preferences: { textStreaming: "0", typingAnimation: "1", typingSpeed: "20" }, reducedMotion: "reduce" });
    f.begin("interrupted", "An interrupted response.");
    await f.page.locator("#message-interrupted").waitFor();
    f.emit({ t: "thread.upsert", thread: { ...thread, status: "stopped" } });
    await f.page.locator('[data-part-id="interrupted-text"]').getByText("An interrupted response.", { exact: true }).waitFor();
    assert.equal(await f.page.locator('[data-part-id="interrupted-text"][aria-busy="true"]').count(), 0);
    await f.close();
  });

  await t.test("settings save streaming controls and remain usable at desktop and narrow widths", async () => {
    const f = await fixture();
    const { page } = f;
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const streaming = page.getByRole("switch", { name: /^Text streaming/ });
    const animation = page.getByRole("switch", { name: /^Typing animation/ });
    await streaming.waitFor();
    assert.equal(await animation.isDisabled(), true);
    await streaming.uncheck();
    await animation.check();
    await page.getByRole("slider", { name: "Typing speed" }).fill("160");
    assert.deepEqual(await page.evaluate(() => ["textStreaming", "typingAnimation", "typingSpeed"].map((key) => localStorage.getItem(`citropy.${key}`))), ["0", "1", "160"]);
    for (const width of [1440, 960]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.getByRole("slider", { name: "Typing speed" }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `/tmp/citropy-settings-${width}.png`, animations: "disabled" });
    }
    await f.close();
  });

  await t.test("subagents stay hidden until expanded and earlier batches remain in the workspace tab", async () => {
    const children = [
      { ...thread, id: "finished", parentThreadId: "chat", parentMessageId: "batch-one", title: "Finished research" },
      { ...thread, id: "active", parentThreadId: "chat", parentMessageId: "batch-one", title: "Active research", running: true, status: "working" },
      { ...thread, id: "nested", parentThreadId: "finished", title: "Nested result" },
    ];
    const f = await fixture({ children });
    const { page } = f;
    assert.equal(await page.getByRole("button", { name: "Active research", exact: true }).count(), 0);
    await page.locator('.thread-row[title="Presentation check"]').hover();
    const toggle = page.locator('.thread-entry > .thread-children-disclosure > .thread-children-clip > .thread-subagents-toggle');
    await toggle.click();
    await page.getByRole("button", { name: "Active research", exact: true }).waitFor();
    await page.getByRole("button", { name: "Finished research", exact: true }).waitFor();
    await toggle.click();
    await page.getByRole("button", { name: "Active research", exact: true }).waitFor({ state: "hidden" });
    await page.evaluate(async () => (await import("/web/src/lib/store.ts")).selectThread("nested"));
    await page.locator('.thread-child[data-active="true"]').getByText("Nested result", { exact: true }).waitFor();
    await page.evaluate(async () => (await import("/web/src/lib/store.ts")).selectThread("chat"));
    f.emit({ t: "thread.upsert", thread: { ...children[1], running: false, status: "idle" } });
    f.emit({ t: "thread.upsert", thread: { ...children[1], id: "new-agent", parentMessageId: "batch-two", createdAt: 10, title: "New research" } });
    await page.getByRole("button", { name: "New research", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Finished research", exact: true }).count(), 0);
    await page.evaluate(async () => {
      const { useApp } = await import("/web/src/lib/store.ts");
      useApp.setState({ panels: [{ id: "subagents", kind: "subagents", projectId: "workspace", title: "Subagents", createdAt: 1 }], activePanels: { workspace: "subagents" }, inspectorOpen: true });
    });
    await page.getByRole("button", { name: /Earlier subagents/ }).click();
    await page.locator('.subagent-history').getByText("Finished research", { exact: true }).waitFor();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.subagent-history-list')).opacity === "1");
    await page.screenshot({ path: "/tmp/citropy-polish-subagents.png", animations: "disabled" });
    await f.close();
  });

  await t.test("composer suggestions use keyboard commands and skills, and navigation collapses by dragging", async () => {
    const f = await fixture();
    const { page } = f;
    await page.route("**/api/skills?*", route => route.fulfill({ json: [
      { id: "review", name: "review", description: "Review this project", provider: "claude", enabled: true, scope: "project", path: "/example/SKILL.md" },
      { id: "disabled", name: "disabled", provider: "claude", enabled: false, scope: "personal" },
    ] }));
    await page.route("**/api/commands?*", route => route.fulfill({ json: [
      { name: "context", description: "Show native context usage" },
      { name: "security-review", description: "Review pending changes for security issues" },
      { name: "model", description: "Native model command" },
    ] }));
    assert.equal(await page.getByRole("button", { name: "Commands", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Add a skill", exact: true }).count(), 0);
    const paperclip = await page.getByRole("button", { name: "Attach images or files", exact: true }).boundingBox();
    const send = await page.getByRole("button", { name: "Send", exact: true }).boundingBox();
    assert.ok(send.x - paperclip.x - paperclip.width < 20);
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await input.fill("Please use @rev");
    await page.getByRole("option", { name: /@review/ }).waitFor();
    await input.press("Enter");
    assert.equal(await input.inputValue(), "Please use @review ");
    assert.equal(f.requests.some(event => event.t === "thread.send"), false);
    await input.press("Enter");
    await page.waitForFunction(() => document.querySelector('textarea').value === "");
    assert.ok(f.requests.some(event => event.t === "thread.send" && event.text === "Please use @review"));
    await input.fill("/");
    await page.getByRole("option", { name: /security-review/ }).waitFor();
    await page.screenshot({ path: "/tmp/citropy-polish-commands.png", animations: "disabled" });
    await input.fill("/cont");
    await input.press("Tab");
    assert.equal(await input.inputValue(), "/context ");
    await input.press("Enter");
    await page.waitForFunction(() => document.querySelector('textarea').value === "");
    assert.ok(f.requests.some(event => event.t === "thread.send" && event.text === "/context"));
    const handle = await page.getByRole("button", { name: "Collapse navigation" }).boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 45, { steps: 10 });
    await page.mouse.up();
    await page.getByRole("button", { name: "Expand navigation" }).waitFor();
    await page.waitForFunction(() => {
      const positions = [...document.querySelectorAll('.navigation-actions .rail-action')].map(node => node.getBoundingClientRect().y);
      return Math.max(...positions) - Math.min(...positions) < 2;
    });
    const actions = await page.locator('.navigation-actions .rail-action').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().y));
    assert.ok(Math.max(...actions) - Math.min(...actions) < 2);
    assert.equal(await page.evaluate(() => localStorage.getItem("citropy.compactNavigation")), "1");
    await page.screenshot({ path: "/tmp/citropy-polish-compact.png", animations: "disabled" });
    await page.setViewportSize({ width: 960, height: 800 });
    await page.screenshot({ path: "/tmp/citropy-polish-narrow.png", animations: "disabled" });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Skills", exact: true }).click();
    assert.equal(await page.locator('h1.settings-title[data-settings-section="skills"] svg').count(), 1);
    await page.screenshot({ path: "/tmp/citropy-polish-settings.png", animations: "disabled" });
    await f.close();
  });

  await t.test("sending with Enter resumes following replies after reading expanded tools", async () => {
    for (const streaming of ["1", "0"]) {
      const history = Array.from({ length: 20 }, (_, index) => message(`history-${index}`, [textPart(`history-text-${index}`, "An earlier paragraph. ".repeat(20))]));
      history.at(-1).parts.push(...tools, textPart("ending", "The earlier task is complete."));
      const f = await fixture({ messages: history, preferences: { textStreaming: streaming, typingAnimation: "1", typingSpeed: "300" } });
      const { page } = f;
      await page.locator(".group-head").click();
      await page.locator(".group-body").waitFor();
      const composer = page.locator("textarea");
      await composer.fill("Please continue.");
      await composer.press("Enter");
      await page.waitForFunction(() => document.querySelector("textarea").value === "");
      assert.ok(f.requests.some((event) => event.t === "thread.send" && event.text === "Please continue."));
      f.emit({ t: "message.add", threadId: "chat", message: { id: "sent", role: "user", ts: 1, parts: [textPart("sent-text", "Please continue.")] } });
      f.begin("following", "A new response. ".repeat(50));
      f.complete("following");
      f.idle();
      await page.locator('[data-part-id="following-text"]').waitFor();
      await page.waitForFunction(() => document.querySelector('[data-part-id="following-text"]')?.getAttribute("aria-busy") !== "true");
      await page.waitForFunction(() => { const node = document.querySelector(".canvas"); return node.scrollHeight - node.clientHeight - node.scrollTop < 2; }, null, { timeout: 2000 });
      await page.locator(".canvas").hover();
      await page.mouse.wheel(0, -400);
      await page.getByRole("button", { name: "Latest", exact: true }).waitFor();
      const position = await page.locator(".canvas").evaluate((node) => new Promise((resolve) => {
        let previous = node.scrollTop;
        let stable = 0;
        const check = () => {
          stable = Math.abs(node.scrollTop - previous) < 1 ? stable + 1 : 0;
          previous = node.scrollTop;
          if (stable >= 4) resolve(previous);
          else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      }));
      f.begin("while-reading", "More new text. ".repeat(60));
      f.complete("while-reading");
      f.idle();
      await page.locator('[data-part-id="while-reading-text"]').waitFor();
      assert.ok(Math.abs(await page.locator(".canvas").evaluate((node) => node.scrollTop) - position) < 2);
      await f.close();
    }
  });

  await t.test("completion notices stay quiet only while the same chat is focused near the bottom", async () => {
    const history = Array.from({ length: 20 }, (_, index) => message(`history-${index}`, [textPart(`history-text-${index}`, "An earlier paragraph. ".repeat(20))]));
    const f = await fixture({ messages: history });
    const { page } = f;
    await page.locator("textarea").focus();
    const notice = (id, threadId = "chat", kind = "chat", level = "success") => ({
      t: "notification.add", notification: { id, kind, level, read: false, title: "Task complete", text: id, createdAt: Date.now(), target: { view: kind === "chat" ? "chat" : "git", threadId } },
    });
    f.emit(notice("already-reading"));
    await page.waitForFunction(async () => (await import("/web/src/lib/store.ts")).useApp.getState().notifications.length === 1);
    assert.equal(await page.locator(".toast").count(), 0);
    assert.equal(await page.evaluate(async () => (await import("/web/src/lib/store.ts")).useApp.getState().notifications[0].read), true);
    assert.ok(f.requests.some((event) => event.t === "notifications.read" && event.ids.includes("already-reading")));
    await page.locator(".canvas").evaluate((node) => node.scrollTop -= 400);
    await page.getByRole("button", { name: "Latest", exact: true }).waitFor();
    f.emit(notice("reading-history"));
    await page.locator(".toast").getByText("reading-history", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Latest", exact: true }).click();
    await page.waitForFunction(() => { const node = document.querySelector(".canvas"); return node.scrollHeight - node.clientHeight - node.scrollTop < 2; });
    f.emit(notice("other-conversation", "elsewhere"), notice("push-complete", "chat", "git"), notice("failed-response", "chat", "chat", "error"));
    for (const text of ["other-conversation", "push-complete", "failed-response"])
      await page.locator(".toast").getByText(text, { exact: true }).waitFor();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    f.emit(notice("while-in-settings"));
    await page.locator(".toast").getByText("while-in-settings", { exact: true }).waitFor();
    await f.close();
  });

  await t.test("typing does not leave a cursor after a list or code block", async () => {
    const f = await fixture({ preferences: { textStreaming: "0", typingAnimation: "1", typingSpeed: "20" } });
    f.begin("list", "A response with a list.\n\n- The first item has enough text to reveal gradually.\n- The second item finishes the response.");
    f.complete("list");
    f.idle();
    await f.page.locator('[data-part-id="list-text"][aria-busy="true"]').waitFor();
    assert.equal(await f.page.locator('[data-part-id="list-text"] > :last-child').evaluate((node) => getComputedStyle(node, "::after").content), "none");
    await f.close();
  });

  await t.test("jump controls and expanded tool lists do not add temporary scroll gaps at any UI scale", async () => {
    const history = Array.from({ length: 30 }, (_, index) => message(`message-${index}`, [textPart(`text-${index}`, `Sample paragraph ${index}. `.repeat(12))]));
    history.at(-1).parts.push(...tools, textPart("ending", "The task is complete."));
    const f = await fixture({ messages: history });
    const { page } = f;
    for (const scale of [90, 120, 150]) {
      await page.evaluate(async (scale) => (await import("/web/src/lib/store.ts")).setUiScale(scale), scale);
      const canvas = page.locator(".canvas");
      await page.waitForFunction(() => document.querySelector('[data-part-id="ending"]')?.textContent.includes("complete"));
      await canvas.evaluate((node) => node.scrollTop = node.scrollHeight);
      const before = await canvas.evaluate((node) => node.scrollHeight);
      await canvas.evaluate((node) => node.scrollTop -= 400);
      await page.getByRole("button", { name: "Latest", exact: true }).waitFor();
      assert.equal(await canvas.evaluate((node) => node.scrollHeight), before);
      await page.getByRole("button", { name: "Latest", exact: true }).click();
      await page.waitForFunction(() => { const node = document.querySelector(".canvas"); return node.scrollHeight - node.clientHeight - node.scrollTop < 2; });
      await page.evaluate(() => {
        window.expansionGaps = [];
        window.expansionHeights = [];
        window.expansionPositions = [];
        const measure = () => {
          const body = document.querySelector(".group-body");
          const inner = document.querySelector(".group-body-inner");
          if (body && inner) {
            window.expansionGaps.push(body.getBoundingClientRect().height - inner.getBoundingClientRect().height);
            window.expansionHeights.push(body.getBoundingClientRect().height);
            const canvas = document.querySelector(".canvas");
            window.expansionPositions.push({top: canvas.scrollTop, height: canvas.scrollHeight, client: canvas.clientHeight});
          }
          if (window.expansionGaps.length < 25) requestAnimationFrame(measure);
        };
        requestAnimationFrame(measure);
      });
      await page.locator(".group-head").click();
      await page.waitForFunction(() => window.expansionGaps.length >= 25);
      assert.ok(await page.evaluate(() => Math.max(...window.expansionGaps) < 1));
      assert.ok(await page.evaluate(() => window.expansionHeights.some((height) => height > 2 && height < Math.max(...window.expansionHeights) - 2)));
      assert.ok(await page.getByRole("button", { name: "Latest", exact: true }).isVisible(), JSON.stringify({ scale, positions: await page.evaluate(() => [window.expansionPositions[0], window.expansionPositions.at(-1)]) }));
      const gap = await page.evaluate(() => document.querySelector(".group-body").getBoundingClientRect().height - document.querySelector(".group-body-inner").getBoundingClientRect().height);
      assert.ok(Math.abs(gap) < 1, `${scale}% scale gap: ${gap}`);
      await page.locator(".group-head").click();
      await page.locator(".group-body").waitFor({ state: "detached" });
    }
    await f.close();
  });
});
