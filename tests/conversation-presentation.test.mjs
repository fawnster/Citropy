import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium, _electron } from "playwright";

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

test("conversation presentation", { timeout: 360_000 }, async (t) => {
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
  const warmup = await browser.newPage();
  await warmup.goto(server.resolvedUrls.local[0], { timeout: 120_000 });
  await warmup.close();
  async function fixture({ desktopPage, preferences = {}, messages = [message("saved", [textPart("saved-text", "Saved conversation.")])], children = [], histories = {}, githubAccount, reducedMotion = "no-preference", isGit = false, hasTouch = false } = {}) {
    const page = desktopPage ?? await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion, hasTouch });
    page.setDefaultTimeout(10000);
    const errors = [];
    const requests = [];
    let connection;
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (entry) => {
      if (entry.type() === "error" && /same key|unique.*key/.test(entry.text())) errors.push(entry.text());
    });
    if (desktopPage) await page.addInitScript(() => {
      window.citropyDesktop = {
        windowState: async () => ({ maximized: false, fullscreen: false, platform: "linux", development: true, version: "0.1.0" }),
        windowCommand: async () => {},
        onWindowState: () => () => {},
        onNotification: () => () => {},
        onBrowserSelect: () => () => {},
      };
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
        if (event.t === "github.request") socket.send(JSON.stringify({ t: "github.result", requestId: event.requestId, result: event.request.operation === "status" ? { installed: true, account: githubAccount, repositories: [] } : { items: [], more: false } }));
        if (event.t === "thread.send" || event.t === "queue.edit") socket.send(JSON.stringify({ t: "thread.accepted", requestId: event.requestId }));
        if (event.t === "thread.load") socket.send(JSON.stringify({ t: "thread.messages", threadId: event.id, messages: histories[event.id] ?? (event.id === "chat" ? messages : [message(`${event.id}-message`, [textPart(`${event.id}-text`, "Subagent result.")])]) }));
      });
      socket.send(JSON.stringify({ t: "hello", snapshot: {
        projects: [{ id: "workspace", name: "Example workspace", path: "/example", isGit, lastOpened: 1 }],
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

  await t.test("desktop running shells dismiss without blocking the workspace", { timeout: 40_000 }, async (test) => {
    const display = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1600x1000x24"], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
    let desktop;
    test.after(async () => { await desktop?.close(); display.kill(); });
    const [number] = await once(display.stdio[3], "data");
    const environment = { ...process.env, DISPLAY: `:${String(number).trim()}` };
    delete environment.ELECTRON_RUN_AS_NODE;
    const main = join(directory, "shell-desktop.cjs");
    await writeFile(main, `const { app, BrowserWindow } = require("electron");
app.setPath("userData", ${JSON.stringify(join(directory, "desktop"))});
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1440, height: 900, x: 0, y: 0, frame: false });
  window.loadURL("about:blank");
});
`);
    desktop = await _electron.launch({ args: ["--ozone-platform=x11", "--no-sandbox", main], env: environment, timeout: 10_000 });
    const f = await fixture({ desktopPage: await desktop.firstWindow() });
    const { page, emit } = f;
    const click = async (locator) => {
      await locator.click({ trial: true });
      const bounds = await locator.boundingBox();
      execFileSync("xdotool", ["mousemove", "--sync", String(Math.round(bounds.x + bounds.width / 2)), String(Math.round(bounds.y + bounds.height / 2)), "click", "1"], { env: environment });
    };
    emit({ t: "shell.upsert", shell: { id: "server", projectId: "workspace", threadId: "chat", command: "npm run dev", cwd: "/example", status: "running", background: true, stopMode: "shell", output: "Server ready\n", startedAt: 1 } });
    const trigger = page.getByRole("button", { name: "Running shells, 1 active", exact: true });
    const panel = page.getByRole("dialog", { name: "Running shells", exact: true });
    const composer = page.locator(".composer-input");
    for (const [width, reducedMotion] of [[1440, "no-preference"], [700, "reduce"]]) {
      await desktop.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
      await page.emulateMedia({ reducedMotion });
      if (width === 700) await click(page.getByRole("button", { name: "Toggle sidebar", exact: true }));
      await click(trigger);
      await panel.waitFor();
      await click(composer);
      await panel.waitFor({ state: "detached", timeout: 2000 });
      assert.equal(await composer.evaluate(element => element === document.activeElement), true);
      await page.keyboard.type("Still clickable");
      assert.equal(await composer.inputValue(), "Still clickable");
      await composer.fill("");
      await click(trigger);
      await click(panel.getByRole("button", { name: "Close running shells", exact: true }));
      await panel.waitFor({ state: "detached" });
      assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
      await click(trigger);
      await panel.waitFor();
      execFileSync("xdotool", ["key", "Escape"], { env: environment });
      await panel.waitFor({ state: "detached" });
      await click(trigger);
      await panel.waitFor();
      await click(page.getByRole("button", { name: "Notifications", exact: true }));
      await panel.waitFor({ state: "detached" });
      await page.getByRole("dialog", { name: "Notifications", exact: true }).waitFor();
      execFileSync("xdotool", ["key", "Escape"], { env: environment });
      await page.getByRole("dialog", { name: "Notifications", exact: true }).waitFor({ state: "detached" });
      const workspace = page.getByRole("button", { name: "Choose workspace, Example workspace", exact: true });
      await click(workspace);
      const menu = page.getByRole("menu");
      const search = menu.getByRole("textbox", { name: "Find a workspace", exact: true });
      await search.waitFor();
      await click(search);
      await page.keyboard.type("Example");
      await click(menu.getByRole("menuitem", { name: /^Example workspace/ }));
      await menu.waitFor({ state: "detached" });
      await click(composer);
      assert.equal(await composer.evaluate(element => element === document.activeElement), true);
      assert.equal(await page.locator(":popover-open").count(), 0);
    }
    await f.close();
  });

  await t.test("running shells stay discoverable across tasks with bounded output and clear stop scope", async () => {
    const other = { ...thread, id: "server-task", title: "Preview the workspace" };
    const f = await fixture({ children: [other] });
    const { page, emit } = f;
    assert.equal(await page.locator(".shells-trigger").count(), 0);
    const shell = { id: "dev-server", projectId: "workspace", threadId: "server-task", command: "npm run dev -- --host 127.0.0.1", cwd: "/example", status: "running", background: true, stopMode: "shell", output: "VITE ready in 241 ms\nLocal: http://127.0.0.1:5173/\nGET / 200\n", startedAt: Date.now() };
    const fallback = { ...shell, id: "tests", threadId: "chat", command: "npm test", background: false, stopMode: "task", output: "Running tests…", startedAt: shell.startedAt - 10 };
    emit({ t: "shell.upsert", shell }, { t: "shell.upsert", shell: fallback });
    await page.getByRole("button", { name: "Running shells, 2 active", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "Running shells", exact: true });
    await panel.waitFor();
    await panel.getByRole("button", { name: "Stop shell", exact: true }).waitFor();
    assert.equal(await panel.getByRole("button", { name: "Stop task", exact: true }).count(), 0);
    assert.equal(await panel.locator(".shell-output").innerText(), shell.output);
    await page.screenshot({ path: "/tmp/citropy-shells-desktop.png", animations: "disabled" });
    await page.setViewportSize({ width: 700, height: 800 });
    await page.waitForTimeout(200);
    const bounds = await panel.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 700 && bounds.y + bounds.height <= 800, JSON.stringify(bounds));
    await page.screenshot({ path: "/tmp/citropy-shells-narrow.png", animations: "disabled" });
    await panel.locator(".shell-row").filter({ hasText: "npm test" }).click();
    await panel.getByRole("button", { name: "Stop task", exact: true }).waitFor();
    await panel.getByText("Stopping this shell also stops its AI task.", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("navigation", { name: "Workspace navigation", exact: true }).getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Running shells, 2 active", exact: true }).click();
    await panel.getByRole("button", { name: "Show command", exact: true }).click();
    await page.waitForFunction(async () => (await import("/web/src/lib/store.ts")).useApp.getState().activeThreadId === "server-task");
    await page.getByRole("button", { name: "Running shells, 2 active", exact: true }).click();
    const requests = [];
    await page.route("**/api/shells/stop", async route => {
      const body = route.request().postDataJSON();
      requests.push(body);
      if (requests.length === 1) return route.fulfill({ status: 503, json: { error: "Provider is unavailable" } });
      emit({ t: "shell.upsert", shell: { ...shell, status: "stopped", endedAt: Date.now() } });
      return route.fulfill({ json: { ok: true } });
    });
    await panel.getByRole("button", { name: "Stop shell", exact: true }).click();
    await panel.getByRole("alert").getByText("Provider is unavailable").waitFor();
    await panel.getByRole("button", { name: "Stop shell", exact: true }).click();
    await page.getByRole("button", { name: "Running shells, 1 active", exact: true }).waitFor();
    assert.deepEqual(requests, [{ id: "dev-server" }, { id: "dev-server" }]);
    assert.equal(await panel.locator(".shell-command").innerText(), shell.command);
    assert.equal(await panel.locator(".shell-output").innerText(), shell.output);
    assert.equal(await panel.locator(".shell-row").filter({ hasText: "npm test" }).count(), 1);
    const nodeCount = await panel.locator("*").count();
    for (let i = 0; i < 120; i++) emit({ t: "shell.upsert", shell: { ...fallback, output: `Progress ${i}\n${"Output line\n".repeat(2000)}` } });
    await page.waitForTimeout(250);
    assert.equal(await panel.locator("*").count(), nodeCount);
    emit({ t: "shell.upsert", shell: { ...fallback, status: "finished", endedAt: Date.now() } });
    await page.getByRole("button", { name: "Running shells, 0 active", exact: true }).waitFor();
    await panel.getByRole("button", { name: "Close running shells", exact: true }).click();
    await panel.waitFor({ state: "hidden" });
    assert.equal(await page.locator(".shells-trigger").count(), 0);
    await page.waitForFunction(() => window.presentationFrames.size === 0);
    const terminal = { ...shell, id: "terminal-shell", panelId: "terminal-panel", command: "npm run preview", startedAt: shell.startedAt + 10 };
    emit({ t: "panel.upsert", panel: { id: "terminal-panel", projectId: "workspace", threadId: "server-task", kind: "terminal", title: "Terminal 1" } }, { t: "shell.upsert", shell: terminal });
    await page.getByRole("button", { name: "Running shells, 1 active", exact: true }).click();
    await panel.getByRole("button", { name: "Open terminal", exact: true }).click();
    await panel.waitFor({ state: "hidden" });
    await page.locator('#panel-body-terminal-panel .xterm-screen').waitFor();
    assert.equal(await page.getByRole("tab", { name: "Terminal 1", exact: true }).getAttribute("aria-selected"), "true");
    assert.ok(f.requests.some(event => event.t === "term.open" && event.termId === "terminal-panel"));
    await page.getByRole("button", { name: "Running shells, 1 active", exact: true }).click();
    emit({ t: "panel.remove", id: "terminal-panel" }, { t: "shell.upsert", shell: { ...terminal, status: "stopped", endedAt: Date.now() } });
    await panel.getByRole("button", { name: "Open task", exact: true }).waitFor();
    await panel.getByRole("button", { name: "Close running shells", exact: true }).click();
    await panel.waitFor({ state: "hidden" });
    await f.close();
  });

  await t.test("shell navigation reveals the exact command and output inside folded work details", async () => {
    const command = { ...tools[0], id: "background-command", callId: "provider:background", name: "Bash", shape: "command", headline: "npm run preview", output: "Preview listening on port 4000" };
    const history = [
      message("command-message", [textPart("intro", "Checking the preview."), ...tools, command, textPart("result", "Preview started.")]),
      ...Array.from({ length: 48 }, (_, index) => ({ ...message(`later-${index}`, [textPart(`later-text-${index}`, `Later conversation ${index}`)]), role: index % 2 ? "assistant" : "user" })),
    ];
    const other = { ...thread, id: "other-task", projectId: "other-workspace", title: "Other task" };
    const f = await fixture({ messages: history, children: [other], histories: { "other-task": history.map(message => ({ ...message, id: `other-${message.id}`, parts: message.parts.map(part => ({ ...part, id: `other-${part.id}` })) })) } });
    const { page, emit } = f;
    emit({ t: "project.upsert", project: { id: "other-workspace", name: "Other workspace", path: "/other", isGit: false, lastOpened: 1 } });
    for (const [width, threadId] of [[1440, "chat"], [640, "other-task"], [640, "other-task"]]) {
      await page.setViewportSize({ width, height: 900 });
      const projectId = threadId === "chat" ? "workspace" : "other-workspace";
      emit({ t: "shell.upsert", shell: { id: `${threadId}:${command.callId}`, projectId, threadId, command: command.headline, cwd: "/example", status: "running", background: true, stopMode: "shell", output: command.output, startedAt: Date.now() } });
      await page.getByRole("button", { name: /^Running shells, \d+ active$/ }).click();
      const panel = page.getByRole("dialog", { name: "Running shells", exact: true });
      await panel.getByRole("button", { name: "Show command", exact: true }).click();
      await panel.waitFor({ state: "hidden" });
      await page.locator('.tool[data-open="true"] .tool-output').getByText(command.output, { exact: true }).waitFor({ timeout: 2000 });
      const target = page.locator('.tool').filter({ hasText: command.headline });
      await page.waitForFunction(() => {
        const element = document.querySelector('.tool[data-open="true"] .tool-head');
        const canvas = document.querySelector('.canvas').getBoundingClientRect();
        const bounds = element?.getBoundingClientRect();
        return bounds && bounds.top >= canvas.top && bounds.bottom <= canvas.bottom;
      });
      assert.equal(await target.locator('.tool-head').evaluate(element => element === document.activeElement), true);
      assert.equal(f.requests.some(event => event.t === "term.open"), false);
      await page.screenshot({ path: `/tmp/citropy-shell-command-${width}.png`, animations: "disabled" });
      await target.locator('.tool-head').click();
      await page.locator('.group').filter({ hasText: command.headline }).locator('.group-head').click();
      await page.locator('.canvas').evaluate(element => { element.scrollTop = element.scrollHeight; });
    }
    emit({ t: "shell.upsert", shell: { id: "chat:removed-command", projectId: "workspace", threadId: "chat", command: "Earlier command", cwd: "/example", status: "running", background: true, stopMode: "shell", output: "Earlier output", startedAt: Date.now() } });
    await page.getByRole("button", { name: "Running shells, 3 active", exact: true }).click();
    await page.getByRole("dialog", { name: "Running shells", exact: true }).getByRole("button", { name: "Show command", exact: true }).click();
    await page.getByText("This command is no longer in the conversation history. Its recent output is available in Running shells.", { exact: true }).waitFor();
    assert.equal(await page.evaluate(async () => (await import('/web/src/lib/store.ts')).useApp.getState().searchShellId), null);
    await f.close();
  });

  await t.test("shell output follows a newly selected process without disturbing older output being read", async () => {
    const f = await fixture();
    const { page, emit } = f;
    const shell = { id: "first", projectId: "workspace", threadId: "chat", command: "first server", cwd: "/example", status: "running", background: true, stopMode: "shell", output: "First output line\n".repeat(300), startedAt: 2 };
    const second = { ...shell, id: "second", command: "second server", output: "Second output line\n".repeat(300), startedAt: 1 };
    emit({ t: "shell.upsert", shell }, { t: "shell.upsert", shell: second });
    await page.getByRole("button", { name: "Running shells, 2 active", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "Running shells", exact: true });
    const output = panel.locator(".shell-output");
    await output.waitFor();
    await output.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
    emit({ t: "shell.upsert", shell: { ...shell, output: `${shell.output}Latest first output` } });
    await output.getByText(/Latest first output/).waitFor();
    assert.equal(await output.evaluate(element => element.scrollTop), 0);
    await panel.locator(".shell-row").filter({ hasText: "second server" }).click();
    await page.waitForFunction(() => {
      const output = document.querySelector(".shell-output");
      return output && output.scrollHeight - output.scrollTop - output.clientHeight < 2;
    }, undefined, { timeout: 1000 });
    await panel.getByRole("button", { name: "Close running shells", exact: true }).click();
    await panel.waitFor({ state: "hidden" });
    await f.close();
  });

  await t.test("GitHub identity is optional and every section keeps workspace navigation available", async () => {
    const account = { login: "octocat", name: "The Octocat", avatar_url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Crect width='40' height='40' rx='20' fill='%239890cd'/%3E%3C/svg%3E", html_url: "https://github.com/octocat" };
    const f = await fixture({ githubAccount: account, preferences: { compactNavigation: "1" }, messages: [
      { ...message("question", [textPart("question-text", "Could you review the navigation?")]), role: "user" },
      message("answer", [textPart("answer-text", "The sections stay within reach. You can switch directly between GitHub, source control, usage, and settings.")]),
    ] });
    const { page } = f;
    await page.locator('#message-question .turn-heading strong').getByText("octocat", { exact: true }).waitFor();
    assert.equal(await page.locator('#message-question .user-avatar img').getAttribute("src"), account.avatar_url);
    const search = await page.getByRole("textbox", { name: "Find a conversation", exact: true }).boundingBox();
    const newThread = await page.getByRole("button", { name: "New thread", exact: true }).boundingBox();
    assert.ok(newThread.x > search.x && Math.abs(newThread.y + newThread.height / 2 - search.y - search.height / 2) < 2);
    for (const width of [1440, 960]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: `/tmp/citropy-navigation-chat-${width}.png`, animations: "disabled" });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("switch", { name: /^Use GitHub profile in chat/ }).uncheck();
    assert.equal(await page.evaluate(() => localStorage.getItem("citropy.showGitHubIdentity")), "0");
    await page.screenshot({ path: "/tmp/citropy-navigation-settings-960.png", animations: "disabled" });
    for (const [name, view] of [["Usage", "usage"], ["Source control", "git"], ["GitHub", "github"], ["Settings", "settings"], ["GitHub", "github"]]) {
      await page.getByRole("navigation", { name: "Workspace navigation", exact: true }).getByRole("button", { name, exact: true }).click();
      await page.locator(`.navigation-actions [data-tone="${view}"][aria-current="page"]`).waitFor();
      assert.equal(await page.getByRole("button", { name: "Back to chat", exact: true }).count(), 1);
    }
    assert.equal(await page.getByRole("button", { name: "Account", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Account settings for octocat", exact: true }).click();
    await page.getByRole("heading", { name: "The Octocat", exact: true }).waitFor();
    await page.screenshot({ path: "/tmp/citropy-navigation-account-960.png", animations: "disabled" });
    await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    await page.locator('#message-question .turn-heading strong').getByText("You", { exact: true }).waitFor();
    assert.equal(await page.locator('#message-question .user-avatar img').count(), 0);
    assert.equal(f.requests.filter(event => event.t === "github.request" && event.request.operation === "status").length, 1);
    await page.reload();
    await page.locator('#message-question .turn-heading strong').getByText("You", { exact: true }).waitFor();
    await f.close();
  });

  await t.test("message actions reveal near either header without gaps, layout work, or hidden click targets", async () => {
    const f = await fixture({ githubAccount: { login: "a-long-account-name-for-the-header" }, preferences: { sidebar: "0" }, messages: [
      { ...message("question", [textPart("question-text", "The push was rejected because the remote branch contains changes.\n\nExplain what happened before changing any files.")]), role: "user" },
      message("answer", [textPart("answer-text", "The remote branch has newer commits.")]),
    ] });
    const { page } = f;
    const turn = page.locator("#message-question");
    const actions = turn.locator(".message-actions");
    const settle = () => page.waitForFunction(() => [...document.querySelectorAll(".turn, .turn *")].every(node => node.getAnimations().every(animation => animation.playState !== "running")));
    const leave = async () => {
      await page.mouse.move(10, 10);
      await page.evaluate(() => document.activeElement?.blur());
      await settle();
    };
    await page.evaluate(() => document.fonts.ready);
    for (const width of [1440, 600, 420]) {
      await page.setViewportSize({ width, height: 900 });
      for (const review of [false, true]) {
        f.emit({ t: "thread.upsert", thread: { ...thread, checkpoints: review ? ["question", "answer"].map(messageId => ({ messageId, before: "before", after: "after", createdAt: 1 })) : [] } });
        await page.waitForFunction(count => document.querySelectorAll("#message-question .message-actions button").length === count, review ? 3 : 2);
        for (const id of ["question", "answer"]) {
          const user = id === "question";
          const message = page.locator(`#message-${id}`);
          const header = message.locator(".turn-heading");
          const toolbar = message.locator(".message-actions");
          const metadata = header.locator(user ? "time" : "strong");
          const body = message.locator(user ? ".user-card" : ".agent-card");
          await leave();
          const resting = await message.evaluate((node, user) => {
            const content = node.querySelector(".turn-heading").getBoundingClientRect();
            const metadata = node.querySelector(user ? "time" : ".turn-heading strong").getBoundingClientRect();
            const actions = node.querySelector(".message-actions");
            const button = actions.querySelector("button").getBoundingClientRect();
            return { gap: user ? content.right - metadata.right : metadata.left - content.left, x: metadata.x, opacity: getComputedStyle(actions).opacity, hiddenTarget: actions.contains(document.elementFromPoint(button.x + button.width / 2, button.y + button.height / 2)) };
          }, user);
          const bubble = await body.boundingBox();
          assert.ok(Math.abs(resting.gap) < 1, JSON.stringify({ width, review, id, resting }));
          assert.equal(resting.opacity, "0");
          assert.equal(resting.hiddenTarget, false);
          await body.hover();
          await settle();
          assert.equal(await toolbar.evaluate(node => getComputedStyle(node).opacity), "0", "Hovering message text must leave actions hidden");
          const heading = await header.boundingBox();
          const content = await message.locator(".message-content").boundingBox();
          const edge = user ? content.x + 2 : content.x + content.width - 2;
          if (edge < heading.x || edge > heading.x + heading.width) {
            await page.mouse.move(edge, heading.y + heading.height / 2);
            await settle();
            assert.equal(await toolbar.evaluate(node => getComputedStyle(node).opacity), "0", "Empty header space must leave actions hidden");
          }
          await header.hover();
          await settle();
          assert.equal(await toolbar.evaluate(node => getComputedStyle(node).opacity), "1");
          const revealed = await metadata.boundingBox();
          assert.ok(user ? revealed.x < resting.x - 40 : revealed.x > resting.x + 30);
          const nearestButton = await toolbar.locator("button").nth(user ? 0 : -1).boundingBox();
          assert.ok(user ? revealed.x + revealed.width < nearestButton.x : nearestButton.x + nearestButton.width < revealed.x);
          assert.deepEqual(await body.boundingBox(), bubble);
          for (const button of await toolbar.locator("button").all()) {
            await button.hover();
            await settle();
            assert.equal(await toolbar.evaluate(node => getComputedStyle(node).opacity), "1");
            assert.equal(await button.evaluate(node => {
              const box = node.getBoundingClientRect();
              return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
            }), true);
          }
          await page.screenshot({ path: `/tmp/citropy-header-zones-${id}-${width}-${review ? "review" : "basic"}.png`, animations: "disabled" });
          await leave();
          assert.ok(Math.abs((await metadata.boundingBox()).x - resting.x) < 1);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        }
      }
    }
    await actions.getByRole("button", { name: "Branch from this message", exact: true }).focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Restore before this message", exact: true });
    await dialog.waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await leave();
    const headers = await page.locator(".turn-heading").all();
    for (const header of headers) {
      await header.hover();
      await settle();
      await leave();
    }
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const layoutCount = async () => (await cdp.send("Performance.getMetrics")).metrics.find(metric => metric.name === "LayoutCount").value;
    const before = await layoutCount();
    for (let index = 0; index < 5; index++) {
      for (const header of headers) {
        await header.hover();
        await settle();
        await leave();
      }
    }
    const layouts = await layoutCount() - before;
    t.diagnostic(`Message actions: ${layouts} layouts across ten hover cycles`);
    assert.ok(layouts <= 1, `Hovering caused ${layouts} layouts`);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await turn.locator(".turn-heading").hover();
    await settle();
    assert.equal(await actions.evaluate(node => getComputedStyle(node).opacity), "1");
    await cdp.detach();
    await f.close();
    const touch = await fixture({ hasTouch: true, preferences: { sidebar: "0" }, messages: [
      { ...message("touch-question", [textPart("touch-question-text", "Explain the changes.")]), role: "user" },
      message("touch-answer", [textPart("touch-answer-text", "The changes are ready.")]),
    ] });
    await touch.page.setViewportSize({ width: 420, height: 900 });
    assert.equal(await touch.page.evaluate(() => matchMedia("(hover: none)").matches), true);
    for (const toolbar of await touch.page.locator(".message-actions").all()) {
      assert.equal(await toolbar.evaluate(node => getComputedStyle(node).opacity), "1");
    }
    await touch.page.getByRole("button", { name: "Restore before this message", exact: true }).tap();
    await touch.page.getByRole("dialog", { name: "Restore before this message", exact: true }).waitFor();
    await touch.page.getByRole("button", { name: "Cancel", exact: true }).tap();
    await touch.close();
  });

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

  await t.test("tool-only activity stays outside speech bubbles and keeps its expandable details", async () => {
    const f = await fixture({ messages: [message("work", [tools[0], { ...tools[1], name: "Bash", shape: "command", headline: "git status" }])] });
    const { page } = f;
    f.emit({ t: "thread.upsert", thread: { ...thread, running: true, status: "thinking", runStartedAt: Date.now() - 3200 } });
    await page.getByRole("button", { name: "Work details", exact: true }).click();
    const activity = page.locator(".turn-agent").filter({ has: page.locator(".group") });
    await activity.getByRole("button", { name: "Read 1 file and ran 1 command", exact: true }).waitFor();
    assert.equal(await activity.locator(".message-bubble").count(), 0);
    assert.equal(await activity.locator(".group-count").count(), 0);
    await page.locator(".working-text").getByText("Thinking", { exact: true }).waitFor();
    for (const width of [1440, 600]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 600) {
        await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
        await page.locator(".rail").waitFor({ state: "detached" });
      }
      await page.waitForFunction(() => getComputedStyle(document.querySelector(".working")).opacity === "1");
      const body = await activity.locator(".agent-activity").boundingBox();
      const thinking = await page.locator(".working-text").boundingBox();
      assert.ok(thinking.y - body.y - body.height <= 18, `Tool activity left ${thinking.y - body.y - body.height}px before thinking.`);
      assert.equal(await page.locator(".turn-agent .turn-heading").count(), 1);
      await page.screenshot({ path: `/tmp/citropy-activity-row-${width}.png`, animations: "disabled" });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await activity.locator(".group-head").click();
    await activity.locator(".group-body").waitFor();
    assert.equal(await activity.locator(".group-body .tool").count(), 2);
    await page.waitForFunction(() => {
      const body = document.querySelector(".group-body");
      const inner = document.querySelector(".group-body-inner");
      return body && inner && Math.abs(body.getBoundingClientRect().height - inner.getBoundingClientRect().height) < 1;
    });
    f.emit({ t: "message.add", threadId: "chat", message: message("empty-after-tools", []) });
    await page.waitForFunction(async () => Boolean((await import("/web/src/lib/store.ts")).useApp.getState().messages["empty-after-tools"]));
    assert.equal(await page.locator(".turn-agent .turn-heading").count(), 1);
    const expanded = await activity.locator(".agent-activity").boundingBox();
    const thinking = await page.locator(".working-text").boundingBox();
    assert.ok(thinking.y - expanded.y - expanded.height >= 0);
    assert.ok(thinking.y - expanded.y - expanded.height <= 18);

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
      return (node.offsetHeight - p.offsetHeight) / 1.2;
    });
    assert.ok(padding <= 26, `Short user messages have ${padding}px of vertical space beyond their text.`);
    await page.locator("#message-reply .turn-heading strong").getByText("Claude Sonnet 5", { exact: true }).waitFor();
    assert.equal(await page.locator("#message-reply .agent-card").count(), 1);
    const lineCount = await page.locator('[data-part-id="multiline-text"] p').evaluate((node) => node.offsetHeight / parseFloat(getComputedStyle(node).lineHeight));
    assert.ok(lineCount > 1.8 && lineCount < 2.2);
    const pieces = page.locator('.turn-agent').filter({ has: page.locator('.agent-card') });
    assert.equal(await pieces.count(), 2);
    await page.getByRole("button", { name: /^Work details/ }).click();
    assert.equal(await pieces.count(), 3);
    assert.equal(await page.locator(".agent-card .group").count(), 0);
    assert.equal(await page.locator(".agent-activity .group").count(), 1);
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
    f.emit({ t: "thread.upsert", thread: { ...thread, model: "claude-sonnet-5", running: true, status: "thinking", runStartedAt: Date.now() - 3200 } });
    for (const width of [1440, 960, 600, 420]) {
      await page.setViewportSize({ width, height: 1100 });
      if (width === 600) {
        await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
        await page.locator(".rail").waitFor({ state: "detached" });
      }
      await page.screenshot({ path: `/tmp/citropy-chat-bubbles-${width}.png`, animations: "disabled" });
      const reading = await page.locator(".canvas-inner").boundingBox();
      const composer = await page.locator(".composer-shell").boundingBox();
      assert.ok(Math.abs(reading.x - composer.x) < 1 && Math.abs(reading.width - composer.width) < 1, JSON.stringify({ width, reading, composer }));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await f.close();
  });

  await t.test("message content shares the composer edges with avatars outside the reading column", async () => {
    const f = await fixture({ preferences: { sidebar: "0" }, messages: [
      { ...message("question", [textPart("question-text", "Check the layout at every window size.")]), role: "user" },
      message("answer", [textPart("answer-text", "The message and composer share a reading column.")]),
    ] });
    const { page } = f;
    await page.evaluate(() => document.fonts.ready);
    for (const [width, scale] of [[1440, 120], [960, 120], [600, 120], [480, 150]]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(async scale => (await import("/web/src/lib/store.ts")).setUiScale(scale), scale);
      const layout = await page.evaluate(() => {
        const composer = document.querySelector(".composer-shell").getBoundingClientRect().toJSON();
        return { composer, wide: document.querySelector(".conversation-viewport").clientWidth > 960, turns: [...document.querySelectorAll(".turn")].filter(node => node.querySelector(".message-avatar")).map(node => ({
          user: node.classList.contains("turn-user"),
          content: node.querySelector(".message-content").getBoundingClientRect().toJSON(),
          avatar: node.querySelector(".message-avatar").getBoundingClientRect().toJSON(),
          heading: node.querySelector(".turn-heading").getBoundingClientRect().toJSON(),
        })) };
      });
      assert.equal(layout.turns.length, 2);
      for (const turn of layout.turns) {
        assert.ok(Math.abs(turn.content.left - layout.composer.left) < 1 && Math.abs(turn.content.right - layout.composer.right) < 1, JSON.stringify({ width, scale, layout }));
        assert.ok(turn.user ? turn.avatar.left > turn.heading.right : turn.avatar.right < turn.heading.left, JSON.stringify(turn));
        if (layout.wide) assert.ok(turn.user ? turn.avatar.left > turn.content.right : turn.avatar.right < turn.content.left, JSON.stringify(turn));
      }
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
      assert.equal(await page.locator("dialog").count(), 0);
      await page.locator(`.thread-row[aria-label="Empty conversation ${index}"][data-active="true"]`).waitFor();
      assert.equal(await page.locator(".conversation-viewport").count(), 1);
      assert.equal(await page.locator(".canvas-hint").count(), 1);
      assert.equal(await page.locator(".turn").count(), 0);
      assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).count(), 1);
    }
    for (const title of ["Presentation check", "Empty conversation 1", "Presentation check", "Empty conversation 2", "Presentation check"]) {
      await page.locator(`.thread-row[aria-label="${title}"]`).click();
      await page.locator(`.thread-row[aria-label="${title}"][data-active="true"]`).waitFor();
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
      await page.mouse.move(0, 0);
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
      const content = await card.locator(".thread-row-body > :last-child").boundingBox();
      const actions = await card.locator(".thread-row-actions").boundingBox();
      const after = await card.boundingBox();
      assert.ok(actions.y >= content.y + content.height - 1, JSON.stringify({ width, sidebar, scale, content, actions }));
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

  await t.test("short replies stay readable and navigation selects the clicked message without moving the app", async () => {
    const f = await fixture({ messages: Array.from({ length: 12 }, (_, index) => message(`quick-${index}`, [textPart(`quick-text-${index}`, index === 4 ? "30." : `Short reply ${index}.`)])) });
    const { page } = f;
    const rail = page.getByRole("navigation", { name: "Conversation messages", exact: true });
    for (const index of [4, 9, 1, 11]) {
      const marker = rail.getByRole("button", { name: `Go to message ${index + 1}`, exact: true });
      await marker.click();
      await page.waitForFunction(index => document.querySelector(`[data-message-index="${index}"]`)?.getAttribute("aria-current") === "location", index);
      assert.equal(await page.evaluate(() => window.scrollY), 0);
      const visible = await page.locator(`#message-quick-${index}`).evaluate(node => {
        const bounds = node.getBoundingClientRect();
        const viewport = document.querySelector(".canvas").getBoundingClientRect();
        return bounds.top >= viewport.top - 2 && bounds.bottom <= viewport.bottom + 2;
      });
      assert.ok(visible);
    }
    const html = await page.evaluate(async () => {
      const { renderMarkdown } = await import("/web/src/lib/markdown.ts");
      return Promise.all(["30.", "30)", "30. A real list item", "1. First\n2. Second"].map(text => renderMarkdown(text, "dark")));
    });
    assert.equal(html[0], "<p>30.</p>");
    assert.equal(html[1], "<p>30)</p>");
    assert.match(html[2], /<ol start="30">/);
    assert.match(html[3], /<li>First<\/li>/);
    await rail.getByRole("button", { name: "Go to message 5", exact: true }).click();
    await page.locator('[data-part-id="quick-text-4"] p').waitFor();
    assert.equal(await page.locator('[data-part-id="quick-text-4"] li').count(), 0);
    await page.mouse.move(1000, 100);
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector(".message-nav-stop > span")).opacity) < 0.3);
    await page.screenshot({ path: "/tmp/citropy-short-replies.png", animations: "disabled" });
    await rail.getByRole("button", { name: "Go to message 5", exact: true }).hover();
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".message-nav-stop > span")).opacity === "1");
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
    await page.getByRole("button", { name: /^Work details/ }).click();
    await page.getByRole("button", { name: "Latest", exact: true }).click();
    await bottom();
    await page.locator(".group-head").click();
    await page.locator(".group-body").waitFor();
    const rail = page.getByRole("navigation", { name: "Conversation messages", exact: true });
    assert.equal(await rail.getByRole("button").count(), history.length);
    const marker = rail.getByRole("button", { name: "Go to message 21", exact: true });
    await marker.hover();
    await page.getByRole("tooltip").getByText(/Paragraph 20/).waitFor();
    await page.screenshot({ path: "/tmp/citropy-message-navigator.png", animations: "disabled" });
    await marker.click();
    await page.locator("#message-history-20").waitFor();
    await page.waitForFunction(() => {
      const message = document.querySelector("#message-history-20")?.getBoundingClientRect();
      const canvas = document.querySelector(".canvas").getBoundingClientRect();
      return message && message.top >= canvas.top - 2 && message.top < canvas.bottom;
    });
    assert.equal(await page.locator('[data-part-id="history-end"]').count(), 0);
    assert.ok(await mounted() < 40);
    await marker.focus();
    await marker.press("ArrowUp");
    assert.equal(await rail.getByRole("button", { name: "Go to message 20", exact: true }).evaluate(node => node === document.activeElement), true);
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("tooltip").count(), 0);
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
      const left = (await f.page.locator("#message-saved").boundingBox()).x;
      f.begin("response", "The first words");
      await f.page.locator("#message-response").waitFor();
      assert.equal((await f.page.locator("#message-saved").boundingBox()).x, left, "Adding the message rail must not shift existing messages.");
      if (streaming === "1") await f.page.locator('[data-part-id="response-text"]').getByText("The first words", { exact: true }).waitFor();
      else assert.equal(await f.page.locator('[data-part-id="response-text"]').count(), 0);
      await f.page.getByRole("button", { name: "Go to message 2", exact: true }).hover();
      await f.page.getByRole("tooltip").getByText(streaming === "1" ? "The first words" : "Response in progress…", { exact: true }).waitFor();
      f.emit({ t: "part.append", threadId: "chat", messageId: "response", partId: "response-text", text: " are now complete." });
      f.complete("response");
      await f.page.locator('[data-part-id="response-text"]').getByText("The first words are now complete.", { exact: true }).waitFor();
      assert.equal(await f.page.locator('[data-part-id="response-text"][aria-busy="true"]').count(), 0);
      f.idle();
      await f.close();
    }
  });

  await t.test("replies fade once while thought text stays still through streaming and history navigation", async () => {
    const f = await fixture();
    const { page } = f;
    await page.evaluate(() => {
      window.proseEntrances = [];
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (frames, options) {
        if (this.matches(".prose")) window.proseEntrances.push(this.dataset.partId);
        return animate.call(this, frames, options);
      };
    });
    f.begin("fresh", "A new response");
    await page.locator('[data-part-id="fresh-text"]').waitFor();
    f.emit({ t: "part.add", threadId: "chat", messageId: "fresh", part: { id: "fresh-thought", kind: "reasoning", text: "Checking **the layout**", complete: false } });
    await page.getByRole("button", { name: "Work details", exact: true }).click();
    await page.getByRole("button", { name: "Thoughts", exact: true }).click();
    await page.locator('[data-part-id="fresh-thought"] strong').waitFor();
    f.emit({ t: "part.append", threadId: "chat", messageId: "fresh", partId: "fresh-text", text: " continues." });
    f.emit({ t: "part.append", threadId: "chat", messageId: "fresh", partId: "fresh-thought", text: " at a narrow width." });
    await page.locator('[data-part-id="fresh-thought"]').getByText("at a narrow width.", { exact: false }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.proseEntrances), ["fresh-text"]);
    assert.equal(await page.locator('[data-part-id="fresh-thought"]').evaluate(node => node.getAnimations().length), 0);
    f.complete("fresh");
    f.idle();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    await page.locator('[data-part-id="fresh-text"]').waitFor();
    assert.deepEqual(await page.evaluate(() => window.proseEntrances), ["fresh-text"]);
    await page.emulateMedia({ reducedMotion: "reduce" });
    f.begin("reduced", "An immediate response.");
    await page.locator('[data-part-id="reduced-text"]').waitFor();
    assert.deepEqual(await page.evaluate(() => window.proseEntrances), ["fresh-text"]);
    await f.close();
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
    await page.locator('.thread-row[aria-label="Presentation check"]').hover();
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

  await t.test("finished conversations reopen from the composer without losing drafts or sending them", async () => {
    const f = await fixture();
    const { page, emit } = f;
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    const notice = page.locator(".composer-finished");
    const reopen = notice.getByRole("button", { name: "Reopen", exact: true });
    for (const width of [1440, 640]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 640) await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
      await input.fill("Continue with the saved draft.");
      emit({ t: "thread.upsert", thread: { ...thread, finished: true } });
      await notice.waitFor();
      const bounds = await notice.boundingBox();
      const action = await reopen.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, JSON.stringify(bounds));
      assert.ok(action.x >= bounds.x && action.x + action.width <= bounds.x + bounds.width, JSON.stringify(action));
      await page.evaluate(async () => (await import("/web/src/lib/store.ts")).useApp.setState({ connected: false }));
      assert.equal(await reopen.isDisabled(), true);
      await page.evaluate(async () => (await import("/web/src/lib/store.ts")).useApp.setState({ connected: true }));
      const previous = f.requests.filter(event => event.t === "thread.finish").length;
      await reopen.focus();
      await page.keyboard.press("Enter");
      await page.waitForTimeout(80);
      assert.deepEqual(f.requests.filter(event => event.t === "thread.finish").slice(previous), [{ t: "thread.finish", id: "chat", finished: false }]);
      f.idle();
      await notice.waitFor({ state: "detached" });
      assert.equal(await input.inputValue(), "Continue with the saved draft.");
      assert.equal(f.requests.some(event => event.t === "thread.send"), false);
    }
    emit({ t: "thread.upsert", thread: { ...thread, finished: true } });
    await notice.waitFor();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("textarea").value === "");
    assert.equal(f.requests.filter(event => event.t === "thread.send" && event.text === "Continue with the saved draft.").length, 1);
    emit({ t: "thread.upsert", thread: { ...thread, finished: true, running: true, status: "working" } });
    await notice.waitFor({ state: "detached" });
    assert.equal(await page.getByRole("button", { name: "Stop", exact: true }).isEnabled(), true);
    await f.close();
  });

  await t.test("composer suggestions use keyboard commands and skills, and navigation collapses by dragging", async () => {
    const f = await fixture({ preferences: { compactNavigation: "0" } });
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
    await page.locator('.composer-highlights .skill-mention').getByText("@review", { exact: true }).waitFor();
    await page.screenshot({ path: "/tmp/citropy-skill-mention.png", animations: "disabled" });
    await input.fill("Use @review with @disabled, unknown @missing and mail@example.com.\n" + "A line that wraps in a narrower editor. ".repeat(140) + "\n@review ");
    assert.equal(await page.locator('.composer-highlights .skill-mention').count(), 2);
    await input.press("Control+End");
    await page.waitForFunction(() => {
      const box = document.querySelector('.composer-input');
      const highlights = document.querySelector('.composer-highlights');
      return box.scrollTop > 0 && Math.abs(box.scrollTop - highlights.scrollTop) < 1 && Math.abs(box.clientWidth - highlights.clientWidth) < 1;
    });
    await page.screenshot({ path: "/tmp/citropy-skill-mention-scrolled.png", animations: "disabled" });
    await input.fill("Please use @review ");
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
      await page.getByRole("button", { name: /^Work details/ }).click();
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
    await page.evaluate(async () => { window.presentationStore = (await import("/web/src/lib/store.ts")).useApp; });
    f.emit(notice("already-reading"));
    await page.waitForFunction(() => window.presentationStore.getState().notifications.length === 1);
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
    await page.getByRole("button", { name: /^Work details/ }).click();
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

  await t.test("long queued logs stay inside the chat with reachable controls", async () => {
    const f = await fixture();
    const { page } = f;
    const queue = [{ id: "log", text: "[main/ERROR]: Incompatible mods found! ".repeat(150), createdAt: 2 }];
    f.emit({ t: "thread.upsert", thread: { ...thread, running: true, status: "thinking", runStartedAt: Date.now() - 10000, queue } });
    await page.getByRole("button", { name: "Expand 1 queued message" }).click();
    for (const width of [1440, 700]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 700) await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
      const sizes = await page.evaluate(() => {
        const stage = document.querySelector(".stage").getBoundingClientRect();
        const queue = document.querySelector(".composer-queue").getBoundingClientRect();
        const remove = document.querySelector('.composer-queue-actions [aria-label="Remove"]').getBoundingClientRect();
        return { width: innerWidth, stageRight: stage.right, queueRight: queue.right, removeRight: remove.right, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.ok(sizes.queueRight <= sizes.stageRight && sizes.stageRight <= width && sizes.removeRight <= sizes.queueRight && !sizes.overflow, JSON.stringify(sizes));
      assert.ok(await page.getByRole("button", { name: "Queue", exact: true }).isVisible());
      await page.screenshot({ path: `/tmp/citropy-long-queue-${width}.png`, animations: "disabled" });
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

  await t.test("empty provider replies do not add space while thinking or hide later content", async () => {
    for (const streaming of ["1", "0"]) {
      const f = await fixture({ preferences: { sidebar: "0", textStreaming: streaming }, messages: [
        { ...message("question", [textPart("question-text", "Tell me how much 15*15 is")]), role: "user" },
      ] });
      const { page } = f;
      const now = Date.now();
      await page.clock.setFixedTime(now);
      const active = { ...thread, provider: "opencode", model: "muse", running: true, status: "thinking", runStartedAt: now - 5300 };
      f.emit(
        { t: "providers.update", providers: [{ id: "opencode", label: "OpenCode", available: true, enabled: true, models: [{ id: "muse", label: "Muse Spark 1.3 Free" }] }] },
        { t: "thread.upsert", thread: active },
      );
      await page.locator(".working-time").getByText("5.3s", { exact: true }).waitFor();
      await page.waitForFunction(() => getComputedStyle(document.querySelector(".working")).opacity === "1");
      await page.locator(".turn-agent .turn-heading strong").getByText("Muse Spark 1.3 Free", { exact: true }).waitFor();
      assert.equal(await page.locator(".turn-agent .turn-heading .turn-provider").textContent(), "OpenCode");
      assert.equal(await page.locator('.turn-agent .agent-avatar .provider-icon[data-provider="opencode"]').count(), 1);
      const before = await page.locator(".working").boundingBox();
      f.emit(
        { t: "message.add", threadId: "chat", message: message("pending", []) },
        { t: "part.add", threadId: "chat", messageId: "pending", part: { id: "pending-reason", kind: "reasoning", text: "", complete: false } },
        { t: "part.add", threadId: "chat", messageId: "pending", part: textPart("pending-text", " \n", false) },
      );
      await page.waitForFunction(async () => (await import("/web/src/lib/store.ts")).useApp.getState().parts["pending-text"]?.text === " \n");
      await page.screenshot({ path: `/tmp/citropy-thinking-pending-${streaming}.png`, animations: "disabled" });
      const after = await page.locator(".working").boundingBox();
      assert.ok(Math.abs(after.y - before.y) < 2, `An empty reply moved the thinking indicator by ${after.y - before.y}px.`);
      assert.equal(await page.locator(".turn-agent").count(), 1);
      assert.equal(await page.locator(".message-nav-stop").count(), 0);
      for (const width of [1440, 600]) {
        await page.setViewportSize({ width, height: 900 });
        await page.clock.setFixedTime(now + 60_000);
        await page.locator(".working-time").getByText("1m 5s", { exact: true }).waitFor();
        assert.equal(await page.locator(".working").count(), 1);
        assert.equal(await page.locator(".turn-agent").count(), 1);
        await page.screenshot({ path: `/tmp/citropy-thinking-compact-${streaming}-${width}.png`, animations: "disabled" });
      }
      if (streaming === "1") {
        f.emit({ t: "part.append", threadId: "chat", messageId: "pending", partId: "pending-reason", text: "Multiplying 15 by 15." });
        await page.getByRole("button", { name: "Work details", exact: true }).waitFor();
        assert.equal(await page.locator(".reason-text").count(), 0);
        await page.getByRole("button", { name: "Work details", exact: true }).click();
        await page.getByRole("button", { name: "Thoughts", exact: true }).click();
        await page.locator(".turn-agent .reason-text").getByText("Multiplying 15 by 15.", { exact: true }).waitFor();
        await page.locator("#message-pending .turn-heading").getByText("Muse Spark 1.3 Free", { exact: true }).waitFor();
        assert.equal(await page.locator(".turn-agent .turn-heading").count(), 1);
      }
      f.emit(
        { t: "part.patch", threadId: "chat", messageId: "pending", partId: "pending-reason", patch: { complete: true } },
        { t: "part.append", threadId: "chat", messageId: "pending", partId: "pending-text", text: "225." },
        { t: "part.patch", threadId: "chat", messageId: "pending", partId: "pending-text", patch: { complete: true } },
        { t: "thread.upsert", thread: { ...active, running: false, status: "idle" } },
      );
      await page.locator('[data-part-id="pending-text"]').getByText("225.", { exact: true }).waitFor();
      await page.locator(".working").waitFor({ state: "detached" });
      assert.equal(await page.locator("#message-pending .turn-heading").count(), 1);
      assert.equal(await page.locator(".message-nav-stop").count(), 2);
      await f.close();
    }
  });

  await t.test("a new turn shows its selected model immediately and stopping leaves no empty reply", async () => {
    const f = await fixture({ preferences: { sidebar: "0" }, messages: [
      { ...message("question", [textPart("question-text", "First question")]), role: "user" },
      { ...message("answer", [textPart("answer-text", "First answer")]), model: "sample" },
    ] });
    const { page } = f;
    f.emit(
      { t: "providers.update", providers: [{ id: "claude", label: "Claude Code", available: true, enabled: true, models: [{ id: "sample", label: "Example model" }, { id: "next", label: "Next model" }] }] },
      { t: "message.add", threadId: "chat", message: { ...message("follow-up", [textPart("follow-up-text", "Next question")]), role: "user" } },
      { t: "thread.upsert", thread: { ...thread, model: "next", running: true, status: "queued", runStartedAt: Date.now() } },
    );
    await page.locator('.turn[data-working] .turn-heading strong').getByText("Next model", { exact: true }).waitFor();
    await page.locator(".working-text").getByText("Queued", { exact: true }).waitFor();
    assert.equal(await page.locator("#message-answer .turn-heading strong").textContent(), "Example model");
    assert.equal(await page.locator(".turn-agent .turn-heading").count(), 2);
    assert.equal(await page.locator(".message-nav-stop").count(), 3);
    f.emit({ t: "thread.upsert", thread: { ...thread, model: "next", running: false, status: "stopped" } });
    await page.locator(".working").waitFor({ state: "detached" });
    assert.equal(await page.locator(".turn-agent").count(), 1);
    assert.equal(await page.locator(".message-nav-stop").count(), 3);
    await f.close();
  });

  await t.test("the thinking indicator loops without a visual reset and respects reduced motion", async () => {
    const f = await fixture();
    f.emit({ t: "thread.upsert", thread: { ...thread, running: true, status: "thinking", runStartedAt: Date.now() - 3200 } });
    const signal = f.page.locator(".working-grid");
    await signal.waitFor();
    await f.page.screenshot({ path: "/tmp/citropy-thinking-desktop.png" });
    assert.equal(await signal.locator("i").count(), 9);
    const frames = await signal.evaluate((element) => [...element.children].map((line) => {
      const animation = line.getAnimations()[0];
      animation.pause();
      const timing = animation.effect.getTiming();
      const sample = (offset) => {
        animation.currentTime = Number(timing.delay) + Number(timing.duration) + offset;
        const style = getComputedStyle(line);
        const box = line.getBoundingClientRect();
        return { opacity: Number(style.opacity), box: [box.x, box.y, box.width, box.height] };
      };
      return { before: sample(-1), after: sample(1), middle: sample(-Number(timing.duration) / 2), iterations: timing.iterations };
    }));
    for (const frame of frames) {
      assert.ok(Math.abs(frame.before.opacity - frame.after.opacity) < 0.005);
      assert.ok(frame.before.box.every((value, index) => Math.abs(value - frame.after.box[index]) < 0.01));
      assert.deepEqual(frame.before.box, frame.middle.box);
      assert.ok(frame.middle.opacity - frame.before.opacity > 0.5);
    }
    for (const scale of [90, 120, 150]) {
      await f.page.evaluate(async scale => (await import("/web/src/lib/store.ts")).setUiScale(scale), scale);
      const centered = await signal.evaluate(element => {
        const icon = element.getBoundingClientRect();
        const line = element.children[4].getBoundingClientRect();
        return Math.abs(line.top + line.height / 2 - icon.top - icon.height / 2);
      });
      assert.ok(centered < 0.05, `Center pixel is off center at ${scale}%: ${centered}px`);
    }
    await f.page.evaluate(async () => (await import("/web/src/lib/store.ts")).setUiScale(120));
    await f.page.evaluate(() => document.documentElement.setAttribute("data-page-hidden", ""));
    assert.equal(await signal.locator("i").first().evaluate((line) => getComputedStyle(line).animationPlayState), "paused");
    await f.page.evaluate(() => document.documentElement.removeAttribute("data-page-hidden"));
    await f.page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await signal.locator("i").first().evaluate((line) => getComputedStyle(line).animationName), "none");
    await f.page.setViewportSize({ width: 620, height: 760 });
    await f.page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
    await f.page.screenshot({ path: "/tmp/citropy-thinking-narrow.png" });
    const bounds = await signal.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 620);
    await f.close();
  });

  await t.test("links show site icons and offer keyboard-accessible browser destinations", async () => {
    const f = await fixture();
    const { page } = f;
    const url = "https://docs.example.test/guide?mode=focus#next";
    const icons = [];
    const network = await page.context().newCDPSession(page);
    await network.send("Fetch.enable", { patterns: [{ urlPattern: "https://*.example.test/favicon.ico" }] });
    network.on("Fetch.requestPaused", async ({ requestId, request }) => {
      const missing = request.url.includes("missing.");
      if (!missing) icons.push({ url: request.url, referer: request.headers.Referer });
      await network.send("Fetch.fulfillRequest", { requestId, responseCode: missing ? 404 : 200,
        responseHeaders: [{ name: "Content-Type", value: "image/svg+xml" }],
        body: Buffer.from(missing ? "" : '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="blue"/></svg>').toString("base64"),
      });
    });
    f.emit({ t: "message.add", threadId: "chat", message: message("links", [textPart("links-text", `[Docs](${url}) and [Missing icon](https://missing.example.test/docs).\n\n[Mail](mailto:hello@example.test) and [Unsafe](javascript:alert%281%29).`)]) });
    const link = page.getByRole("link", { name: "Docs", exact: true });
    await link.locator(".link-site-icon[data-loaded]").waitFor();
    assert.deepEqual(icons, [{ url: "https://docs.example.test/favicon.ico", referer: undefined }]);
    const fallback = page.getByRole("link", { name: "Missing icon", exact: true });
    await fallback.locator("img[hidden]").waitFor({ state: "attached" });
    assert.equal(await fallback.locator("svg").isVisible(), true);
    assert.equal(await page.getByRole("link", { name: "Unsafe", exact: true }).getAttribute("href"), "#");
    assert.equal(await page.getByRole("link", { name: "Mail", exact: true }).locator(".link-site-icon").count(), 0);
    await link.click();
    const menu = page.getByRole("menu", { name: "docs.example.test", exact: true });
    await menu.waitFor();
    assert.equal(await menu.getByRole("menuitem", { name: /^Open in Citropy/ }).isDisabled(), true);
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    assert.equal(await link.evaluate(node => node === document.activeElement), true);
    await page.evaluate(() => {
      window.citropyDesktop = {};
      window.openedLinks = [];
      window.open = (...args) => { window.openedLinks.push(args); return null; };
    });
    await page.keyboard.press("Enter");
    await menu.waitFor();
    assert.equal(await menu.getByRole("menuitem", { name: "Open in Citropy", exact: true }).isEnabled(), true);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await menu.waitFor({ state: "detached" });
    assert.deepEqual(await page.evaluate(() => window.openedLinks), [[url, "_blank", "noopener,noreferrer"]]);
    assert.equal(f.requests.some(event => event.t === "panel.open"), false);
    await link.click();
    await menu.getByRole("menuitem", { name: "Open in Citropy", exact: true }).click();
    await menu.waitFor({ state: "detached" });
    const request = f.requests.find(event => event.t === "panel.open");
    assert.equal(request?.url, url);
    assert.equal(request?.kind, "browser");
    assert.equal(request?.projectId, "workspace");
    assert.equal(request?.threadId, "chat");
    await page.getByRole("button", { name: "Toggle inspector", exact: true }).click();
    await page.setViewportSize({ width: 620, height: 760 });
    await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
    await link.click();
    const bounds = await menu.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 620 && bounds.y + bounds.height <= 760);
    await page.getByRole("textbox", { name: "Message", exact: true }).click();
    await menu.waitFor({ state: "detached" });
    assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).evaluate(node => node === document.activeElement), true);
    await link.click();
    await menu.waitFor();
    f.emit({ t: "part.patch", threadId: "chat", messageId: "links", partId: "links-text", patch: { text: "The linked message has been replaced." } });
    await menu.waitFor({ state: "detached" });
    await page.getByText("The linked message has been replaced.", { exact: true }).waitFor();
    await f.close();
  });

  await t.test("the elapsed turn time survives settings navigation and resets only for a new run", async () => {
    const f = await fixture();
    const { page } = f;
    const runStartedAt = Date.now() - 125000;
    f.emit({ t: "thread.upsert", thread: { ...thread, running: true, status: "thinking", runStartedAt } });
    await page.locator(".working-time").filter({ hasText: "2m" }).waitFor();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    await page.locator(".working-time").filter({ hasText: "2m" }).waitFor();
    f.emit({ t: "thread.upsert", thread: { ...thread, running: true, status: "working", activeTool: "Read", runStartedAt } });
    await page.locator(".working-text").filter({ hasText: "Read" }).waitFor();
    assert.match(await page.locator(".working-time").innerText(), /^2m/);
    f.emit({ t: "thread.upsert", thread: { ...thread, running: true, status: "thinking", runStartedAt: Date.now() } });
    await page.waitForFunction(() => !document.querySelector(".working-time")?.textContent.includes("m"));
    await f.close();
  });

  await t.test("AI Git controls keep their state, settings choose writing models, and UI text stays unselected", async () => {
    const f = await fixture({ isGit: true, children: [{ ...thread, id: "pinned", title: "Pinned conversation", pinned: true }] });
    const { page } = f;
    let settings = { automaticTitles: true, titleModel: null, commitModel: null };
    const calls = [];
    await page.route("**/api/providers/assistance", async (route) => {
      settings = { ...settings, ...route.request().postDataJSON() };
      f.emit({ t: "assistance.settings", settings });
      await route.fulfill({ json: settings });
    });
    const job = { ...thread, gitAction: { action: "commit", status: "generating" } };
    await page.route("**/api/threads/git-action?**", async (route) => {
      calls.push(route.request().postDataJSON());
      f.emit({ t: "thread.upsert", thread: job });
      await route.fulfill({ json: job.gitAction });
    });
    f.emit({ t: "git.status", projectId: "workspace", threadId: "chat", status: { branch: "main", ahead: 0, behind: 0, clean: false, files: [{ path: "source.ts", staged: true, index: "M", work: " ", added: 1, removed: 1, untracked: false }] } });
    const pinnedColor = await page.locator('[data-category="pinned"] .category-icon').evaluate((node) => getComputedStyle(node).color);
    const activeColor = await page.locator('[data-category="active"] .category-icon').evaluate((node) => getComputedStyle(node).color);
    assert.notEqual(pinnedColor, activeColor);
    await page.getByRole("button", { name: "Git actions", exact: true }).click();
    await page.getByRole("dialog", { name: "Git actions", exact: true }).waitFor();
    assert.equal(await page.locator(".composer-actions .git-panel-trigger").count(), 0);
    await page.getByText("1 staged file", { exact: true }).waitFor();
    await page.getByRole("button", { name: "AI commit", exact: true }).click();
    await page.locator(".git-panel-progress").filter({ hasText: "Writing commit" }).waitFor();
    assert.deepEqual(calls, [{ action: "commit", scope: "staged" }]);
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("A follow-up after the commit");
    assert.equal(await page.getByRole("button", { name: "Send", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "AI assistance", exact: true }).click();
    for (const label of ["Title model", "Commit model"]) {
      await page.getByRole("button", { name: `${label}: Use the conversation model`, exact: true }).click();
      await page.getByRole("menuitem", { name: /^Example model/ }).click();
      await page.getByRole("menu").waitFor({ state: "detached" });
    }
    await page.getByRole("switch", { name: /^Automatic titles/ }).uncheck();
    assert.equal(settings.automaticTitles, false);
    assert.deepEqual(settings.commitModel, { provider: "claude", model: "sample" });
    assert.deepEqual(settings.titleModel, settings.commitModel);
    const description = page.getByText("Choose the model that names your conversations.", { exact: true });
    assert.equal(await description.evaluate((node) => getComputedStyle(node).userSelect), "none");
    for (const width of [1440, 600]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 600) await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
      await page.screenshot({ path: `/tmp/citropy-ai-settings-${width}.png`, animations: "disabled" });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
    await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    await page.locator(".git-panel-progress").filter({ hasText: "Writing commit" }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).evaluate((node) => getComputedStyle(node).userSelect), "text");
    assert.equal(await page.locator(".message-bubble").first().evaluate((node) => getComputedStyle(node).userSelect), "text");
    f.emit({ t: "thread.upsert", thread: { ...job, gitAction: { action: "commit", status: "success", message: "Fix workspace selection", commit: "1234567890123456789012345678901234567890" } } });
    f.emit({ t: "git.status", projectId: "workspace", threadId: "chat", status: { branch: "main", ahead: 1, behind: 0, clean: true, files: [] } });
    await page.getByText("Last commit", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Git actions", exact: true }).innerText(), "Git");
    assert.equal(await page.getByRole("button", { name: "AI commit", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Push", exact: true }).isEnabled(), true);
    assert.equal(await page.getByRole("button", { name: "Send", exact: true }).isEnabled(), true);
    await page.getByText("Last commit", { exact: true }).click();
    for (const width of [1440, 600]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 600) await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
      await page.getByText("Fix workspace selection", { exact: true }).waitFor();
      const panel = await page.getByRole("dialog", { name: "Git actions", exact: true }).boundingBox();
      const trigger = await page.getByRole("button", { name: "Git actions", exact: true }).boundingBox();
      assert.ok(panel.x >= 0 && panel.x + panel.width <= width + 1);
      assert.ok(panel.y >= trigger.y + trigger.height && panel.y + panel.height <= 900);
      await page.screenshot({ path: `/tmp/citropy-ai-git-${width}.png`, animations: "disabled" });
    }
    await page.keyboard.press("Escape");
    await page.locator(".git-panel").waitFor({ state: "detached" });
    assert.equal(await page.getByRole("button", { name: "Git actions", exact: true }).evaluate((button) => button === document.activeElement), true);
    await f.close();
  });

  await t.test("the floating Git panel follows current changes, retries pushes, and can stay hidden", async () => {
    const f = await fixture({ isGit: true });
    const { page } = f;
    const initial = { branch: "main", ahead: 1, behind: 0, clean: false, files: [
      { path: "server/assistance.ts", staged: false, index: " ", work: "M", added: 48, removed: 12, untracked: false },
      { path: "web/GitActions.tsx", staged: false, index: " ", work: "M", added: 96, removed: 24, untracked: false },
    ] };
    const previous = { action: "commit", status: "success", message: "Previous commit", commit: "abcdef012345678901234567890123456789012345" };
    f.emit({ t: "thread.upsert", thread: { ...thread, gitAction: previous } });
    f.emit({ t: "git.status", projectId: "workspace", threadId: "chat", status: initial });
    const trigger = page.getByRole("button", { name: "Git actions", exact: true });
    await trigger.click();
    const panel = page.getByRole("dialog", { name: "Git actions", exact: true });
    await panel.getByText("2 changed files", { exact: true }).waitFor();
    assert.equal(await panel.getByText("Previous commit", { exact: true }).isVisible(), false);
    assert.equal(await panel.getByRole("button", { name: "AI commit", exact: true }).isEnabled(), true);
    await panel.getByText("+144", { exact: true }).waitFor();
    await panel.getByText("-36", { exact: true }).waitFor();
    const location = await trigger.boundingBox();
    const inspector = await page.getByRole("button", { name: "Toggle inspector", exact: true }).boundingBox();
    assert.ok(location.x < inspector.x && Math.abs(location.y - inspector.y) < 2);
    const calls = [];
    await page.route("**/api/threads/git-action?**", async (route) => {
      const request = route.request().postDataJSON();
      calls.push(request);
      const action = { action: request.action, status: request.action === "push" ? "pushing" : "generating" };
      f.emit({ t: "thread.upsert", thread: { ...thread, gitAction: action } });
      await route.fulfill({ json: action });
    });
    await page.screenshot({ path: "/tmp/citropy-git-panel-changes-1440.png", animations: "disabled" });
    await panel.getByRole("button", { name: "AI commit & push", exact: true }).click();
    await panel.locator(".git-panel-progress").filter({ hasText: "Writing commit" }).waitFor();
    assert.deepEqual(calls, [{ action: "commitPush", scope: "all" }]);
    const failure = "Committed successfully, but the push failed. Use Push to retry.";
    f.emit({ t: "thread.upsert", thread: { ...thread, gitAction: { action: "commitPush", status: "error", message: failure, commit: previous.commit } } });
    f.emit({ t: "git.status", projectId: "workspace", threadId: "chat", status: { ...initial, clean: true, files: [] } });
    await panel.getByRole("alert").filter({ hasText: failure }).waitFor();
    await panel.getByRole("button", { name: "Push", exact: true }).click();
    await panel.locator(".git-panel-progress").filter({ hasText: "Pushing" }).waitFor();
    assert.deepEqual(calls[1], { action: "push", scope: "all" });
    assert.equal(await panel.getByRole("button", { name: "Push", exact: true }).isDisabled(), true);
    f.emit({ t: "thread.upsert", thread: { ...thread, gitAction: { action: "push", status: "success" } } });
    f.emit({ t: "git.status", projectId: "workspace", threadId: "chat", status: { ...initial, clean: true, files: [], ahead: 0 } });
    await panel.getByText("No commits to push", { exact: true }).waitFor();
    assert.equal(await panel.getByRole("button", { name: "Push", exact: true }).isDisabled(), true);
    assert.equal(await trigger.innerText(), "Git");
    await panel.getByRole("button", { name: "Hide Git panel", exact: true }).click();
    await panel.waitFor({ state: "detached" });
    assert.equal(await trigger.getAttribute("aria-expanded"), "false");
    assert.equal(await page.evaluate(() => localStorage.getItem("citropy.gitPanel")), "0");
    await page.reload();
    await trigger.waitFor();
    assert.equal(await trigger.getAttribute("aria-expanded"), "false");
    await page.clock.install();
    const refreshes = f.requests.filter((event) => event.t === "git.refresh").length;
    await page.clock.runFor(5500);
    assert.equal(f.requests.filter((event) => event.t === "git.refresh").length, refreshes);
    await f.close();
  });

  await t.test("the Git panel stays inside narrow windows and does not reuse another thread's result", async () => {
    const other = { ...thread, id: "worktree", title: "Worktree conversation", workspacePath: "/example/worktree", workspaceBranch: "feature/other" };
    const f = await fixture({ isGit: true, children: [other, { ...thread, id: "child-agent", parentThreadId: "chat", title: "Child agent" }] });
    const { page } = f;
    f.emit({ t: "thread.upsert", thread: { ...thread, gitAction: { action: "commit", status: "success", message: "Old conversation commit" } } });
    f.emit({ t: "git.status", projectId: "workspace", threadId: "chat", status: { branch: "main", ahead: 2, behind: 0, clean: true, files: [] } });
    await page.getByRole("button", { name: "Git actions", exact: true }).click();
    await page.getByText("Last commit", { exact: true }).click();
    await page.getByText("Old conversation commit", { exact: true }).waitFor();
    await page.locator('.thread-card').filter({ hasText: "Worktree conversation" }).click();
    const panel = page.getByRole("dialog", { name: "Git actions", exact: true });
    await panel.getByText("feature/other", { exact: true }).waitFor();
    assert.equal(await panel.getByText("Last commit", { exact: true }).count(), 0);
    assert.equal(await panel.getByRole("button", { name: "Push", exact: true }).isDisabled(), true);
    f.emit({ t: "git.status", projectId: "workspace", threadId: "worktree", status: { branch: "feature/other", ahead: 0, behind: 1, clean: true, files: [] } });
    await panel.getByText("1 commit behind upstream", { exact: true }).waitFor();
    assert.equal(await panel.getByRole("button", { name: "Push", exact: true }).getAttribute("title"), "Sync this branch before pushing");
    for (const [width, scale] of [[600, 120], [480, 150]]) {
      await page.setViewportSize({ width, height: 700 });
      await page.evaluate(async (scale) => (await import("/web/src/lib/store.ts")).setUiScale(scale), scale);
      await page.waitForFunction(() => {
        const box = document.querySelector(".git-panel")?.getBoundingClientRect();
        return box && box.x >= 0 && box.right <= innerWidth + 1 && box.y >= 0 && box.bottom <= innerHeight;
      }, undefined, { timeout: 1000 });
      const box = await panel.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
      assert.ok(box.y >= 0 && box.y + box.height <= 700);
      await page.screenshot({ path: `/tmp/citropy-git-panel-${width}-${scale}.png`, animations: "disabled" });
    }
    assert.ok(f.requests.some((event) => event.t === "git.refresh" && event.threadId === "worktree"));
    f.emit({ t: "git.status", projectId: "workspace", threadId: "worktree", status: { branch: "feature/other", upstream: null, ahead: 0, behind: 0, clean: true, files: [] } });
    await panel.getByText("No upstream branch", { exact: true }).waitFor();
    await panel.getByRole("button", { name: "Open Source control to publish this branch", exact: true }).waitFor();
    assert.equal(await panel.getByText("No commits to push", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "Hide Git panel", exact: true }).click();
    await page.evaluate(async () => (await import("/web/src/lib/store.ts")).selectThread("child-agent"));
    assert.equal(await page.getByRole("button", { name: "Git actions", exact: true }).count(), 1);
    await f.close();
  });
});
