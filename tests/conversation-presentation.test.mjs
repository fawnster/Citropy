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
    server: { host: "127.0.0.1", port: 0, watch: null },
  });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  async function fixture({ preferences = {}, messages = [message("saved", [textPart("saved-text", "Saved conversation.")])], children = [], histories = {}, reducedMotion = "no-preference" } = {}) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion });
    page.setDefaultTimeout(10000);
    const errors = [];
    const requests = [];
    let connection;
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (entry) => {
      if (entry.type() === "error" && /same key|unique.*key/.test(entry.text())) errors.push(entry.text());
    });
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
        if (event.t === "thread.send" || event.t === "queue.edit") socket.send(JSON.stringify({ t: "thread.accepted", requestId: event.requestId }));
        if (event.t === "thread.load") socket.send(JSON.stringify({ t: "thread.messages", threadId: event.id, messages: histories[event.id] ?? (event.id === "chat" ? messages : [message(`${event.id}-message`, [textPart(`${event.id}-text`, "Subagent result.")])]) }));
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

  await t.test("conversation menus stay visible above the sidebar footer and support keyboard navigation", async () => {
    const f = await fixture({ preferences: { compactNavigation: "1" }, children: Array.from({ length: 12 }, (_, index) => ({ ...thread, id: `other-${index}`, title: `Other conversation ${index}` })) });
    const { page } = f;
    const row = page.locator('.thread-card').last();
    for (const [width, scale] of [[1440, 120], [960, 150]]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(async (scale) => (await import("/web/src/lib/store.ts")).setUiScale(scale), scale);
      await row.scrollIntoViewIfNeeded();
      await row.hover();
      await row.getByRole("button", { name: /Organize Other conversation/ }).click();
      const menu = page.getByRole("menu");
      await menu.waitFor();
      const opening = await menu.boundingBox();
      assert.ok(opening.y >= 0 && opening.y + opening.height <= 800, JSON.stringify(opening));
      const last = menu.getByRole("menuitem").last();
      await menu.press("End");
      const visible = await last.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= innerHeight && node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      });
      assert.ok(visible, "The last menu action must be visible and clickable above the footer.");
      assert.equal(await last.evaluate((node) => node === document.activeElement), true);
      const bounds = await menu.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
      await page.screenshot({ path: `/tmp/citropy-chat-menu-${width}.png`, animations: "disabled" });
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });
      assert.equal(await row.getByRole("button", { name: /Organize Other conversation/ }).evaluate((node) => node === document.activeElement), true);
    }
    await page.locator(".workspace-select").click();
    const search = page.getByRole("textbox", { name: "Find a workspace", exact: true });
    assert.equal(await search.evaluate((node) => node === document.activeElement), true);
    await page.keyboard.type("Example workspace");
    await page.getByRole("menuitem", { name: /^Example workspace/ }).waitFor();
    await page.keyboard.press("Escape");
    await f.close();
  });

  await t.test("chat bubbles fit short messages, preserve line breaks and resolve runtime model names", async () => {
    const f = await fixture({ messages: [
      { ...message("greeting", [textPart("greeting-text", "Hello!")]), role: "user" },
      { ...message("reply", [textPart("reply-text", "Hi. What do you need?")]), model: "claude-sonnet-5[1m]" },
      { ...message("multiline", [textPart("multiline-text", "First line\nSecond line")]), role: "user" },
      message("work", [textPart("work-start", "I’ll check the workspace."), ...tools, textPart("work-end", "The review is complete.")]),
    ] });
    const { page } = f;
    f.emit(
      { t: "providers.update", providers: [{ id: "claude", label: "Claude Code", available: true, enabled: true, models: [{ id: "claude-sonnet-5", label: "Claude Sonnet 5", aliases: ["sonnet"] }] }] },
      { t: "thread.upsert", thread: { ...thread, model: "claude-sonnet-5" } },
    );
    await page.locator('[data-part-id="greeting-text"] p').waitFor();
    const padding = await page.locator("#message-greeting .user-card").evaluate((node) => {
      const p = node.querySelector("p");
      return node.offsetHeight - p.offsetHeight;
    });
    assert.ok(padding <= 26, `Short user messages have ${padding}px of vertical space beyond their text.`);
    await page.locator("#message-reply .turn-heading strong").getByText("Claude Sonnet 5", { exact: true }).waitFor();
    assert.equal(await page.locator("#message-reply .agent-card").count(), 1);
    const lineCount = await page.locator('[data-part-id="multiline-text"] p').evaluate((node) => node.offsetHeight / parseFloat(getComputedStyle(node).lineHeight));
    assert.ok(lineCount > 1.8 && lineCount < 2.2);
    const pieces = page.locator('.turn-agent').filter({ has: page.locator('.agent-card') });
    assert.equal(await pieces.count(), 4);
    const continuation = await page.locator('.turn-agent[data-continuation="true"]').first().boundingBox();
    const beginning = await page.locator('#message-work').boundingBox();
    assert.ok(Math.abs(beginning.y + beginning.height - continuation.y) < 2);
    await page.locator(".group-head").click();
    await page.locator(".group-body").waitFor();
    await page.waitForFunction(() => {
      const body = document.querySelector(".group-body");
      const inner = document.querySelector(".group-body-inner");
      return body && inner && Math.abs(body.getBoundingClientRect().height - inner.getBoundingClientRect().height) < 1;
    });
    for (const width of [1440, 960]) {
      await page.setViewportSize({ width, height: 1100 });
      await page.screenshot({ path: `/tmp/citropy-chat-bubbles-${width}.png`, animations: "disabled" });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await f.close();
  });

  await t.test("creating and switching conversations leaves exactly one isolated chat surface", async () => {
    const f = await fixture({ histories: { "new-1": [], "new-2": [] } });
    const { page } = f;
    await page.route("**/api/workspaces?*", (route) => route.fulfill({ json: { hasCommits: false, branches: [], worktrees: [] } }));
    let created = 0;
    await page.route("**/api/threads", (route) => {
      const next = { ...thread, id: `new-${++created}`, title: `Empty conversation ${created}` };
      f.emit({ t: "thread.upsert", thread: next });
      return route.fulfill({ json: next });
    });
    for (let index = 1; index <= 2; index++) {
      await page.getByRole("button", { name: "New thread", exact: true }).click();
      await page.getByRole("menuitem", { name: "Claude Code", exact: true }).click();
      await page.getByRole("button", { name: "Create conversation", exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "detached" });
      await page.locator(`.thread-row[title="Empty conversation ${index}"][data-active="true"]`).waitFor();
      assert.equal(await page.locator(".conversation-viewport").count(), 1);
      assert.equal(await page.locator(".canvas-hint").count(), 1);
      assert.equal(await page.locator(".turn").count(), 0);
      assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).count(), 1);
    }
    for (const title of ["Presentation check", "Empty conversation 1", "Presentation check", "Empty conversation 2", "Presentation check"]) {
      await page.locator(`.thread-row[title="${title}"]`).click();
      await page.locator(`.thread-row[title="${title}"][data-active="true"]`).waitFor();
      assert.equal(await page.locator(".conversation-viewport").count(), 1);
      if (title === "Presentation check") {
        await page.locator('[data-part-id="saved-text"]').waitFor();
        assert.equal(await page.locator(".turn").count(), 1);
        assert.equal(await page.locator(".canvas-hint").count(), 0);
      } else {
        assert.equal(await page.locator(".turn").count(), 0);
        assert.equal(await page.locator(".canvas-hint").count(), 1);
      }
    }
    await f.close();
  });

  await t.test("thread actions have their own space and compact navigation uses equal button sizes", async () => {
    const title = "Review the workspace and check the latest changes";
    const f = await fixture({ preferences: { compactNavigation: "1" }, messages: [
      { ...message("question", [textPart("question-text", "Please check the changes in this workspace.")]), role: "user" },
      message("saved", [textPart("saved-text", "The changes are ready to review.\n\n- The conversation history stays separate.\n- The sidebar actions are available below each title.")]),
    ] });
    const { page } = f;
    f.emit({ t: "thread.upsert", thread: { ...thread, title, workspaceBranch: "main", changedFiles: 19 } });
    const card = page.locator('.thread-card[data-active="true"]');
    await card.getByText(title, { exact: true }).waitFor();
    for (const [width, sidebar, scale] of [[1600, 252, 120], [960, 216, 120], [1440, 360, 150]]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(async ({ sidebar, scale }) => {
        const { useApp, setUiScale } = await import("/web/src/lib/store.ts");
        setUiScale(scale);
        useApp.setState((state) => ({ panelWidths: { ...state.panelWidths, sidebar } }));
      }, { sidebar, scale });
      await page.locator(".canvas").hover();
      const before = await card.boundingBox();
      await card.hover();
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.thread-card[data-active="true"] .thread-row-actions')).opacity === "1");
      const content = await card.locator(".thread-row").boundingBox();
      const actions = await card.locator(".thread-row-actions").boundingBox();
      const after = await card.boundingBox();
      assert.ok(actions.y >= content.y + content.height - 1);
      assert.ok(actions.x >= after.x && actions.x + actions.width <= after.x + after.width);
      assert.ok(Math.abs(before.height - after.height) < 1);
      const buttons = await page.locator(".navigation-actions .rail-action").evaluateAll((nodes) => nodes.map((node) => {
        const { width, height, y } = node.getBoundingClientRect();
        return { width, height, y };
      }));
      assert.equal(buttons.length, 5);
      for (const button of buttons) {
        assert.ok(Math.abs(button.width - buttons[0].width) < 1, JSON.stringify(buttons));
        assert.ok(Math.abs(button.height - buttons[0].height) < 1, JSON.stringify(buttons));
        assert.ok(Math.abs(button.y - buttons[0].y) < 1, JSON.stringify(buttons));
      }
      const avatar = await page.locator(".agent-avatar").evaluate((node) => {
        const style = getComputedStyle(node);
        return { border: style.borderTopWidth, background: style.backgroundColor };
      });
      assert.deepEqual(avatar, { border: "0px", background: "rgba(0, 0, 0, 0)" });
      await page.screenshot({ path: `/tmp/citropy-thread-polish-${width}.png`, animations: "disabled" });
      const overflow = await page.evaluate(() => ({
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        elements: [...document.querySelectorAll(".topbar, .rail, .stage, .thread-card, .thread-row, .navigation-actions, .composer")].map((node) => ({ class: node.className, right: node.getBoundingClientRect().right, width: node.getBoundingClientRect().width })),
      }));
      assert.ok(overflow.scrollWidth <= overflow.width, JSON.stringify(overflow));
    }
    await card.getByRole("button", { name: `Organize ${title}`, exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: "Rename…", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    assert.equal(await card.getByRole("button", { name: `Organize ${title}`, exact: true }).evaluate((node) => node === document.activeElement), true);
    await card.getByRole("button", { name: `Finish ${title}`, exact: true }).click();
    await page.waitForTimeout(50);
    assert.ok(f.requests.some((event) => event.t === "thread.finish" && event.id === "chat" && event.finished));
    await card.getByRole("button", { name: `Delete ${title}`, exact: true }).click();
    await page.getByRole("dialog").waitFor();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await f.close();
  });

  await t.test("a growing conversation keeps the visible message when its timeline starts windowing", async () => {
    const f = await fixture({ messages: Array.from({ length: 40 }, (_, index) => message(`short-${index}`, [textPart(`short-text-${index}`, `History ${index}. `.repeat(15))])) });
    const target = f.page.locator("#message-short-10");
    await target.scrollIntoViewIfNeeded();
    await f.page.getByRole("button", { name: "Latest", exact: true }).waitFor();
    const before = await target.evaluate((node) => node.getBoundingClientRect().top);
    f.begin("next-row", "The next response.");
    f.complete("next-row");
    f.idle();
    await f.page.waitForTimeout(300);
    const after = await target.evaluate((node) => node.getBoundingClientRect().top);
    assert.ok(Math.abs(before - after) < 2, JSON.stringify({ before, after }));
    await f.close();
  });

  await t.test("long conversations mount a bounded timeline and keep navigation, search and live following usable", async () => {
    const history = Array.from({ length: 200 }, (_, index) => message(`history-${index}`, [
      textPart(`history-text-${index}`, `Paragraph ${index}. `.repeat(20)),
    ]));
    history.push(message("long-turn", Array.from({ length: 160 }, (_, index) => textPart(`section-${index}`, `Section ${index}. `.repeat(15)))));
    history.at(-1).parts.push(...tools, textPart("history-end", "End of saved history."));
    const f = await fixture({ messages: history });
    const { page } = f;
    const bottom = () => page.waitForFunction(() => {
      const node = document.querySelector(".canvas");
      return node && node.scrollHeight - node.clientHeight - node.scrollTop < 2;
    });
    const mounted = () => page.locator(".timeline-row").count();
    await page.locator('[data-part-id="history-end"]').waitFor();
    await bottom();
    assert.ok(await mounted() < 40);
    assert.equal(await page.locator('[data-part-id="history-text-0"]').count(), 0);
    for (let index = 0; index < 6; index++) {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Back to chat", exact: true }).waitFor();
      assert.equal(await mounted(), 0);
      await page.getByRole("button", { name: "Back to chat", exact: true }).click();
      await page.locator('[data-part-id="history-end"]').waitFor();
      await bottom();
      assert.ok(await mounted() < 40);
    }
    await page.locator(".group-head").click();
    await page.locator(".group-body").waitFor();
    await page.evaluate(async () => {
      const { useApp } = await import("/web/src/lib/store.ts");
      useApp.setState({ searchMessageId: "history-20" });
    });
    await page.locator("#message-history-20").waitFor();
    await page.waitForFunction(() => {
      const message = document.querySelector("#message-history-20")?.getBoundingClientRect();
      const canvas = document.querySelector(".canvas").getBoundingClientRect();
      return message && message.top >= canvas.top - 2 && message.top < canvas.bottom;
    });
    assert.equal(await page.locator('[data-part-id="history-end"]').count(), 0);
    const position = await page.locator(".canvas").evaluate((node) => node.scrollTop);
    const anchor = await page.locator("#message-history-20").evaluate((node) => node.getBoundingClientRect().top);
    f.begin("background-response", "A response while reading older messages.");
    f.complete("background-response");
    f.idle();
    await page.waitForTimeout(200);
    const afterPosition = await page.locator(".canvas").evaluate((node) => node.scrollTop);
    const afterAnchor = await page.locator("#message-history-20").evaluate((node) => node.getBoundingClientRect().top);
    assert.ok(Math.abs(afterAnchor - anchor) < 2, JSON.stringify({ position, afterPosition, anchor, afterAnchor }));
    await page.getByRole("button", { name: "Latest", exact: true }).click();
    await bottom();
    await page.locator('[data-part-id="background-response-text"]').waitFor();
    await page.locator('.group[data-open="true"]').waitFor();
    await page.locator(".group-head").click();
    await page.locator("textarea").fill("Continue with another response.");
    await page.locator("textarea").press("Enter");
    f.begin("streaming-response", "Streaming begins.");
    await page.locator('[data-part-id="streaming-response-text"]').waitFor();
    await bottom();
    f.emit({ t: "part.append", threadId: "chat", messageId: "streaming-response", partId: "streaming-response-text", text: "\n\n" + "Growing answer. ".repeat(150) });
    await page.locator('[data-part-id="streaming-response-text"]').getByText(/Growing answer/).waitFor();
    await bottom();
    f.complete("streaming-response");
    f.idle();
    for (const [width, scale] of [[1600, 90], [1280, 120], [960, 150]]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(async (scale) => (await import("/web/src/lib/store.ts")).setUiScale(scale), scale);
      if (width / (scale / 100) <= 720)
        await page.getByRole("button", { name: "Close navigation", exact: true }).click();
      await bottom();
      assert.ok(await mounted() < 40);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: `/tmp/citropy-chat-windowed-${width}.png`, animations: "disabled" });
    }
    await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.waitForFunction(() => window.presentationFrames.size === 0);
    await f.close();
  });

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

  await t.test("queued follow-ups stay visible and editable, and messages written offline wait for the connection", async () => {
    const until = async (check) => {
      for (let index = 0; index < 150; index++) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("Expected request was not sent");
    };
    const f = await fixture();
    const { page } = f;
    const provider = { id: "claude", label: "Claude Code", available: true, enabled: true, models: [{ id: "sample", label: "Example model" }], steerHint: "Claude Code reads it at its next step." };
    const queue = [
      { id: "tests", text: "Check the tests too", createdAt: 2 },
      { id: "review", text: "/review", createdAt: 3, attachments: [{ id: "file", path: "/example/notes.txt", label: "notes.txt" }] },
    ];
    f.emit({ t: "providers.update", providers: [provider] }, { t: "thread.upsert", thread: { ...thread, running: true, status: "working", queue } });
    const list = page.getByRole("list", { name: "Queued messages" });
    const row = (text) => list.getByRole("listitem").filter({ hasText: text });
    const summary = page.getByRole("button", { name: "Expand 2 queued messages" });
    await summary.waitFor();
    assert.match(await summary.innerText(), /\/review/);
    assert.equal(await list.isVisible(), false);
    assert.ok((await page.locator(".composer-queue").boundingBox()).height < 52);
    await page.screenshot({ path: "/tmp/citropy-queue-compact.png", animations: "disabled" });
    await page.setViewportSize({ width: 600, height: 900 });
    await page.getByRole("button", { name: "Toggle sidebar" }).click();
    await page.screenshot({ path: "/tmp/citropy-queue-compact-narrow.png", animations: "disabled" });
    assert.ok(await summary.evaluate((element) => element.scrollWidth <= element.clientWidth));
    await page.setViewportSize({ width: 1440, height: 900 });
    await summary.click();
    await row("Check the tests too").waitFor();
    await page.getByText("Sends when Claude Code finishes", { exact: true }).waitFor();
    assert.equal(await row("Check the tests too").getByRole("button", { name: "Send now" }).getAttribute("title"), "Claude Code reads it at its next step.");
    assert.equal(await row("/review").getByRole("button", { name: "Send now" }).count(), 0);
    await page.screenshot({ path: "/tmp/citropy-queue.png", animations: "disabled" });
    await row("Check the tests too").getByRole("button", { name: "Send now" }).click();
    await row("/review").getByRole("button", { name: "Move up" }).click();
    await row("/review").getByRole("button", { name: "Remove" }).click();
    await until(() => f.requests.filter((event) => event.t.startsWith("queue.")).length === 3);
    assert.deepEqual(f.requests.filter((event) => event.t.startsWith("queue.")).map(({ t, id, index }) => ({ t, id, index })), [
      { t: "queue.send", id: "tests", index: undefined },
      { t: "queue.move", id: "review", index: 0 },
      { t: "queue.remove", id: "review", index: undefined },
    ]);
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await row("Check the tests too").getByRole("button", { name: "Edit" }).click();
    await page.waitForFunction(() => document.querySelector("textarea").value === "Check the tests too");
    await input.fill("One more thing");
    await page.getByRole("button", { name: "Queue", exact: true }).click();
    await until(() => f.requests.some((event) => event.t === "thread.send" && event.text === "One more thing"));
    await page.evaluate(async () => (await import("/web/src/lib/store.ts")).useApp.setState({ connected: false }));
    await input.fill("Written while offline");
    await input.press("Enter");
    await row("Written while offline").getByText("Waiting for connection", { exact: true }).waitFor();
    await page.getByText("Sends when Citropy reconnects", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("citropy.offline")).chat[0].text), "Written while offline");
    await page.screenshot({ path: "/tmp/citropy-queue-offline.png", animations: "disabled" });
    await page.evaluate(async () => (await import("/web/src/lib/store.ts")).useApp.setState({ connected: true }));
    await until(() => f.requests.some((event) => event.t === "thread.send" && event.text === "Written while offline"));
    await row("Written while offline").waitFor({ state: "detached" });
    await f.close();
  });

  await t.test("the thinking indicator loops without a visual reset and respects reduced motion", async () => {
    const f = await fixture();
    f.emit({ t: "thread.upsert", thread: { ...thread, running: true, status: "thinking" } });
    const weave = f.page.locator(".working-weave");
    await weave.waitFor();
    const frames = await weave.evaluate((element) => [...element.children].map((line) => {
      const animation = line.getAnimations()[0];
      animation.pause();
      const timing = animation.effect.getTiming();
      const sample = (offset) => {
        animation.currentTime = Number(timing.delay) + Number(timing.duration) + offset;
        const style = getComputedStyle(line);
        return { opacity: Number(style.opacity), scale: new DOMMatrix(style.transform).a };
      };
      return { before: sample(-1), after: sample(1), middle: sample(-Number(timing.duration) / 2), iterations: timing.iterations };
    }));
    for (const frame of frames) {
      assert.ok(Math.abs(frame.before.opacity - frame.after.opacity) < 0.005);
      assert.ok(Math.abs(frame.before.scale - frame.after.scale) < 0.005);
      assert.ok(frame.middle.opacity - frame.before.opacity > 0.5);
    }
    await f.page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await weave.locator("i").first().evaluate((line) => getComputedStyle(line).animationIterationCount), "1");
    await f.close();
  });
});
