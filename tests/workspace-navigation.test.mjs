import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";
import { modelSettings } from "../shared/model-options.ts";

const projects = [
  { id: "first", name: "First workspace", path: "/example/first", isGit: true, lastOpened: 1 },
  { id: "second", name: "Second workspace", path: "/example/second", isGit: true, lastOpened: 1, settings: { provider: "codex", model: "codex-extended" } },
];
const providers = [
  { id: "claude", label: "Claude Code", available: true, enabled: true, models: [{ id: "claude-fast", label: "Claude Fast", isDefault: true, efforts: ["low", "high"], defaultEffort: "high" }, { id: "claude-extended", label: "Claude Extended" }] },
  { id: "codex", label: "Codex", available: true, enabled: true, models: [{ id: "codex-fast", label: "Codex Fast", isDefault: true }, { id: "codex-extended", label: "Codex Extended", efforts: ["low", "medium", "high"], defaultEffort: "medium" }] },
  { id: "opencode", label: "OpenCode", available: true, enabled: true, models: [{ id: "open-fast", label: "OpenCode Fast", hint: "opencode", isDefault: true }] },
];
const thread = { id: "chat", projectId: "first", provider: "claude", model: "claude-fast", title: "Current conversation", permissionMode: "manual", status: "idle", running: false, externalId: "session", createdAt: 1, updatedAt: 1, usage: { input: 280000, output: 1900, cacheRead: 100000, cacheWrite: 2000, costUsd: 4.3, contextTokens: 82000, contextMax: 200000, turns: 4 } };
const account = { login: "example", avatar_url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'/%3E", html_url: "https://github.com/example" };

test("workspace navigation and conversation setup stay consistent", { timeout: 90_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-navigation-"));
  const server = await createServer({ configFile: false, cacheDir: join(directory, "cache"), root: fileURLToPath(new URL("..", import.meta.url)), plugins: [react()], logLevel: "error", server: { host: "127.0.0.1", port: 0, watch: null } });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await rm(directory, { recursive: true, force: true }); });

  async function fixture(test, { chat = true, catalogs = providers } = {}) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(7000);
    const errors = [];
    const requests = [];
    let connection;
    const created = new Map();
    const states = Object.fromEntries(projects.map(project => [project.id, {
      repository: true, hasCommits: true, mergeInProgress: false,
      status: { branch: "main", ahead: 0, behind: 0, files: [{ path: `src/${project.id}.ts`, index: " ", work: "M", staged: false, untracked: false, added: 1, removed: 0 }] },
      commits: [], branches: [{ name: "main", current: true, remote: false }], remotes: [], stashes: [],
    }]));
    page.on("pageerror", error => errors.push(error.message));
    test.after(async () => { await page.close(); assert.deepEqual(errors, []); });
    await page.addInitScript(chat => {
      for (const [key, value] of Object.entries({ project: "first", thread: chat ? "chat" : "", inspector: "0", theme: "dark", uiScale: "120", compactNavigation: "1" })) localStorage.setItem(`citropy.${key}`, value);
    }, chat);
    await page.route("**/api/workspaces?*", route => route.fulfill({ json: { hasCommits: true, branches: ["main"], worktrees: [{ path: "/example/worktree", branch: "feature/existing", locked: false }] } }));
    await page.route("**/api/browser/profiles?*", route => route.fulfill({ json: { selected: "workspace", profiles: [{ id: "workspace", name: "Workspace", projectId: "first", cookies: 0, activeTabs: 0 }] } }));
    await page.route("**/api/browser/sources?*", route => route.fulfill({ json: [{ id: "chromium", name: "Work", browser: "Chromium" }] }));
    await page.route("**/api/threads", route => {
      const input = route.request().postDataJSON();
      requests.push({ t: "create", ...input });
      const result = { ...thread, ...input, id: `created-${created.size + 1}`, title: "New thread", externalId: undefined, usage: { ...thread.usage, turns: 0 }, running: false };
      created.set(result.id, result);
      return route.fulfill({ json: result });
    });
    await page.route("**/api/threads/compact?*", route => {
      requests.push({ t: "compact", threadId: new URL(route.request().url()).searchParams.get("threadId") });
      connection.send(JSON.stringify({ t: "thread.upsert", thread: { ...thread, compacting: true, running: true, status: "working", activeTool: "Compacting context" } }));
      return route.fulfill({ json: { ok: true } });
    });
    await page.routeWebSocket("**/socket", socket => {
      connection = socket;
      socket.onMessage(raw => {
        const event = JSON.parse(raw);
        requests.push(event);
        if (event.t === "thread.config") {
          const current = created.get(event.id) ?? thread;
          const provider = catalogs.find(entry => entry.id === (event.provider ?? current.provider));
          const updated = { ...current, ...event, ...modelSettings(provider.models, { ...current, ...event }) };
          created.set(event.id, updated);
          socket.send(JSON.stringify({ t: "thread.upsert", thread: updated }));
          socket.send(JSON.stringify({ t: "thread.accepted", requestId: event.requestId }));
        }
        if (event.t === "thread.load") socket.send(JSON.stringify({ t: "thread.messages", threadId: event.id, messages: event.id === "chat" ? [{ id: "reply", role: "assistant", ts: 1, parts: [{ id: "reply-text", kind: "text", text: "Your changes are ready to review.", complete: true }] }] : [] }));
        if (event.t === "panel.close") socket.send(JSON.stringify({ t: "panel.remove", id: event.id }));
        if (event.t === "term.open") socket.send(JSON.stringify({ t: "term.data", termId: event.termId, data: "Terminal ready\r\n" }));
        if (event.t === "git.refresh") socket.send(JSON.stringify({ t: "git.status", projectId: event.projectId, status: states[event.projectId].status }));
        if (event.t === "git.diff") socket.send(JSON.stringify({ t: "git.diff", requestId: event.requestId, patch: { path: event.path, added: 1, removed: 0, hunks: [{ header: "", oldStart: 1, newStart: 1, lines: [{ type: "add", text: "export const updated = true;", newNo: 1 }] }] } }));
        if (event.t === "git.manage") {
          const state = states[event.projectId];
          if (event.operation === "stageAll") state.status.files = state.status.files.map(file => ({ ...file, staged: true, index: "M", work: " " }));
          socket.send(JSON.stringify({ t: "git.manage", requestId: event.requestId, result: event.operation === "stageAll" ? "Staged changes." : state }));
        }
        if (event.t === "github.request") {
          const request = event.request;
          const result = request.operation === "status"
            ? { installed: true, account, repositories: [{ name: "origin", repo: `example/${request.projectId ?? "first"}` }], branch: "main", hasCommits: true }
            : request.operation === "repository"
              ? { id: 1, full_name: request.repo, name: request.repo.split("/").at(-1), owner: account, description: "Example repository", default_branch: "main", private: false, fork: false, archived: false, html_url: `https://github.com/${request.repo}`, stargazers_count: 0, forks_count: 0, open_issues_count: 0, updated_at: "2026-09-12T10:00:00Z" }
              : { items: [], more: false };
          socket.send(JSON.stringify({ t: "github.result", requestId: event.requestId, result }));
        }
      });
      socket.send(JSON.stringify({ t: "hello", snapshot: { projects, threads: chat ? [thread] : [], providers: catalogs, permissions: [], home: "/example" } }));
    });
    await page.goto(server.resolvedUrls.local[0]);
    await page.getByRole("button", { name: "Choose workspace, First workspace", exact: true }).waitFor();
    return { page, requests, states, emit: event => connection.send(JSON.stringify(event)) };
  }

  await t.test("workspace actions and pinned, active, and finished categories are distinct", async test => {
    const { page, emit } = await fixture(test);
    assert.equal(await page.locator(".topbar .workspace-select").count(), 1);
    assert.equal(await page.locator(".rail .workspace-select").count(), 0);
    await page.getByRole("button", { name: "Active 1", exact: true }).waitFor();
    emit({ t: "thread.upsert", thread: { ...thread, id: "pinned", title: "Pinned conversation", pinned: true } });
    emit({ t: "thread.upsert", thread: { ...thread, id: "finished", title: "Finished conversation", finished: true } });
    const pinned = page.locator('.thread-category[data-category="pinned"]');
    await pinned.getByRole("button", { name: "Pinned 1", exact: true }).waitFor();
    assert.equal(await pinned.locator(".thread-card").count(), 1);
    const active = page.locator('.thread-category[data-category="active"]');
    const activeToggle = active.getByRole("button", { name: "Active 1", exact: true });
    await activeToggle.waitFor();
    assert.equal(await active.locator(".thread-card").count(), 1);
    await activeToggle.click();
    await active.locator(".thread-card").waitFor({ state: "detached" });
    await activeToggle.click();
    await active.getByText("Current conversation", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Finished 1", exact: true }).locator("svg.category-icon").count(), 1);
    await page.getByRole("button", { name: "Finished 1", exact: true }).click();
    await page.getByText("Finished conversation", { exact: true }).waitFor();
    assert.deepEqual(await page.locator(".thread-category").evaluateAll(nodes => nodes.map(node => node.dataset.category)), ["pinned", "active", "finished"]);
    const headings = await page.locator('.finished-toggle').evaluateAll(nodes => nodes.map(node => ({ height: node.getBoundingClientRect().height })));
    assert.equal(headings.length, 3);
    assert.ok(headings.every(heading => heading.height < 44));
    const searchBox = await page.locator(".thread-toolbar").boundingBox();
    const firstHeading = await pinned.locator(".finished-toggle").boundingBox();
    assert.ok(firstHeading.y - searchBox.y - searchBox.height < 12);
    assert.deepEqual(await page.locator(".navigation-actions > button").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label"))), ["Source control", "GitHub", "Usage", "Settings"]);
    for (const width of [1440, 600]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.screenshot({ path: `/tmp/citropy-conversation-categories-${width}.png`, animations: "disabled" });
      await page.locator(".workspace-select").click();
      const menu = page.getByRole("menu");
      await menu.getByRole("menuitem", { name: /^Open another folder/ }).waitFor();
      await menu.getByText("Workspace actions", { exact: true }).waitFor();
      await menu.getByText("Remove First workspace from the sidebar. Files stay on disk.", { exact: true }).waitFor();
      const bounds = await menu.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
      await page.screenshot({ path: `/tmp/citropy-workspace-menu-${width}.png`, animations: "disabled" });
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(async () => (await import("/web/src/lib/store.ts")).useApp.setState({ inspectorOpen: true }));
    const open = page.getByRole("button", { name: "Open panel", exact: true });
    await open.waitFor();
    assert.equal(await open.locator("svg").count(), 1);
    await open.click();
    await page.getByRole("menuitem", { name: /^Files/ }).waitFor();
    await page.screenshot({ path: "/tmp/citropy-open-panel-menu.png", animations: "disabled" });
  });

  await t.test("workspace tabs shrink inside the panel and keep overflow panels reachable", async test => {
    const { page } = await fixture(test);
    const panels = [
      ...["changes", "files", "tools", "subagents"].map(kind => ({ id: kind, kind, projectId: "first", title: kind[0].toUpperCase() + kind.slice(1) })),
      ...Array.from({ length: 12 }, (_, index) => ({ id: `shell-${index}`, kind: "terminal", projectId: "first", title: `Terminal ${index + 1}: a long workspace command` })),
    ];
    await page.evaluate(async panels => {
      const { useApp } = await import("/web/src/lib/store.ts");
      useApp.setState({ inspectorOpen: true, panels: panels.slice(0, 4), activePanels: { first: "files" }, panelWidths: { inspector: 320 } });
    }, panels);
    const strip = page.getByRole("tablist", { name: "Open workspace panels", exact: true });
    const contained = async () => {
      await page.waitForFunction(() => {
        const bounds = document.querySelector('.workbench-tabs')?.getBoundingClientRect();
        return bounds && bounds.left >= 0 && bounds.right <= innerWidth + 1;
      });
      const boxes = await strip.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth, bounds: element.getBoundingClientRect().toJSON(), tabs: [...element.querySelectorAll('[role="tab"], .workbench-close, .workbench-overflow')].map(tab => tab.getBoundingClientRect().toJSON()) }));
      assert.ok(boxes.scroll <= boxes.width, JSON.stringify(boxes));
      assert.ok(boxes.tabs.every(tab => tab.left >= boxes.bounds.left && tab.right <= boxes.bounds.right + 1 && tab.width >= 18), JSON.stringify(boxes));
      const add = await page.getByRole("button", { name: "Open panel", exact: true }).boundingBox();
      assert.ok(Math.abs(boxes.bounds.y + boxes.bounds.height / 2 - add.y - add.height / 2) < 2);
    };
    for (const width of [1440, 960]) {
      await page.setViewportSize({ width, height: 1000 });
      await strip.getByRole("tab", { name: "Files", exact: true }).waitFor();
      await contained();
      assert.equal(await strip.getByRole("tab").count(), 4);
      assert.equal(await strip.getByRole("button", { name: "More panels", exact: true }).count(), 0);
      await page.screenshot({ path: `/tmp/citropy-workspace-tabs-${width}.png`, animations: "disabled" });
    }
    await page.evaluate(async panels => (await import("/web/src/lib/store.ts")).useApp.setState({ panels }), panels);
    const more = strip.getByRole("button", { name: "More panels", exact: true });
    await more.waitFor();
    await contained();
    await more.click();
    const menu = page.getByRole("menu", { name: "More panels", exact: true });
    await page.screenshot({ path: "/tmp/citropy-workspace-tabs-menu.png", animations: "disabled" });
    await menu.getByRole("menuitem", { name: panels.at(-1).title, exact: true }).click();
    const active = strip.getByRole("tab", { name: panels.at(-1).title, exact: true });
    await active.waitFor();
    assert.equal(await active.getAttribute("aria-selected"), "true");
    await page.waitForFunction(() => document.activeElement?.closest('#panel-body-shell-11 .term'));
    await contained();
    await page.screenshot({ path: "/tmp/citropy-workspace-tabs-overflow.png", animations: "disabled" });
    await active.press("Home");
    await strip.getByRole("tab", { name: "Changes", exact: true }).waitFor();
    assert.equal(await strip.getByRole("tab", { name: "Changes", exact: true }).evaluate(element => element === document.activeElement), true);
    await page.keyboard.press("End");
    await active.waitFor();
    assert.equal(await active.evaluate(element => element === document.activeElement), true);
    await page.keyboard.press("ArrowLeft");
    await page.locator('#panel-body-shell-10 .xterm-helper-textarea').waitFor({ state: "attached" });
    assert.equal(await strip.getByRole("tab", { name: panels.at(-2).title, exact: true }).evaluate(element => element === document.activeElement), true);
    await page.keyboard.press("End");
    await active.waitFor();
    assert.equal(await active.evaluate(element => element === document.activeElement), true);
    await more.click();
    const removed = panels[7];
    await menu.getByRole("button", { name: `Close ${removed.title}`, exact: true }).click();
    await menu.getByRole("menuitem", { name: removed.title, exact: true }).waitFor({ state: "detached" });
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    await page.setViewportSize({ width: 1800, height: 1000 });
    await page.evaluate(async () => (await import("/web/src/lib/store.ts")).setPanelWidth("inspector", 600));
    await contained();
    assert.equal(await active.getAttribute("aria-selected"), "true");
    await page.evaluate(async panels => (await import("/web/src/lib/store.ts")).useApp.setState({ panels: panels.slice(0, 2) }), panels);
    await strip.getByRole("tab", { name: "Files", exact: true }).locator(".truncate").waitFor();
    await contained();
    assert.equal(await more.count(), 0);
    await page.screenshot({ path: "/tmp/citropy-workspace-tabs-wide.png", animations: "disabled" });
  });

  await t.test("update notifications open the relevant settings without starting a download", async test => {
    const { page, emit } = await fixture(test);
    await page.route("**/api/providers/maintenance*", route => route.fulfill({ json: [] }));
    await page.evaluate(() => {
      window.updateCommands = [];
      window.citropyDesktop = {
        updateState: async () => ({ status: "available", currentVersion: "0.1.0", version: "0.2.0" }),
        updateCommand: async command => { window.updateCommands.push(command); return { status: "ready", currentVersion: "0.1.0", version: "0.2.0" }; },
      };
    });
    for (const [index, section] of ["Providers", "Application"].entries()) {
      emit({ t: "notification.add", notification: { id: `update-${index}`, title: "Update available", text: index ? "Citropy 0.2.0" : "Codex 1.1.0", kind: "update", level: "info", read: false, createdAt: Date.now(), target: { view: "settings", section } } });
      await page.locator(".toast").getByRole("button", { name: "Open settings", exact: true }).last().waitFor();
      await page.locator(".notification-trigger").click();
      await page.locator(".notification-copy").filter({ hasText: index ? "Citropy 0.2.0" : "Codex 1.1.0" }).click();
      await page.locator(".settings-title").getByText(section, { exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.updateCommands), []);
    }
    const update = page.locator(".settings").getByRole("button", { name: "Download update", exact: true });
    await update.waitFor();
    await update.click();
    assert.deepEqual(await page.evaluate(() => window.updateCommands), ["download"]);
    await page.locator(".settings").getByRole("button", { name: "Restart & apply", exact: true }).waitFor();
    const tooltip = page.locator(".app-update-settings [role=tooltip]");
    assert.equal(await tooltip.evaluate(node => {
      const bounds = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(bounds.x + 10, bounds.y + 10));
    }), true);
    await page.screenshot({ path: "/tmp/citropy-manual-updates.png", animations: "disabled" });
    await page.setViewportSize({ width: 600, height: 900 });
    await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
    await page.locator(".app-update-settings button").hover();
    await page.screenshot({ path: "/tmp/citropy-manual-updates-narrow.png", animations: "disabled" });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  });

  await t.test("new-thread buttons open chat directly and remember the last provider, model, and effort", async test => {
    const { page, requests } = await fixture(test, { chat: false });
    assert.equal(await page.locator(".welcome .pill, .welcome .status-dot").count(), 0);
    await page.locator(".welcome").getByRole("button", { name: "New thread", exact: true }).click();
    await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
    assert.equal(await page.locator("dialog").count(), 0);
    await page.getByRole("button", { name: "Model: Claude Fast", exact: true }).click();
    await page.getByRole("group", { name: "Model · Provider", exact: true }).getByRole("button", { name: "Codex", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Codex Extended/ }).click();
    await page.getByRole("button", { name: "Model: Codex Extended", exact: true }).waitFor();
    await page.getByRole("button", { name: /^Model options:/ }).click();
    await page.getByRole("menuitem", { name: /^Low/ }).click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("citropy.threadDefaults")).effort === "low");
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Keep this draft in the first thread");
    await page.locator(".thread-toolbar").getByRole("button", { name: "New thread", exact: true }).click();
    await page.locator('.thread-row[data-active="true"]').waitFor();
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="Message"]')?.value === "");
    const input = requests.filter(event => event.t === "create").at(-1);
    assert.equal(input.provider, "codex");
    assert.equal(input.model, "codex-extended");
    assert.equal(input.effort, "low");
    assert.deepEqual(input.workspace, { kind: "current" });
    assert.equal(await page.locator(".turn").count(), 0);
    await page.reload();
    await page.locator(".welcome").getByRole("button", { name: "New thread", exact: true }).click();
    await page.getByRole("button", { name: "Model: Codex Extended", exact: true }).waitFor();
    assert.equal(requests.filter(event => event.t === "create").at(-1).effort, "low");
    await page.route("**/api/threads", route => route.fulfill({ status: 500, json: { error: "Workspace unavailable" } }));
    const previous = await page.locator('.thread-row[data-active="true"]').getAttribute("aria-label");
    await page.locator(".thread-toolbar").getByRole("button", { name: "New thread", exact: true }).click();
    await page.getByText("Workspace unavailable", { exact: true }).waitFor();
    assert.equal(await page.locator('.thread-row[data-active="true"]').getAttribute("aria-label"), previous);
    assert.equal(await page.locator(".thread-toolbar").getByRole("button", { name: "New thread", exact: true }).isEnabled(), true);
  });

  await t.test("global and folder defaults take precedence while automatic selection remembers the last model", async test => {
    const { page, requests, emit } = await fixture(test, { chat: false });
    emit({ t: "project.defaults", settings: { provider: "codex", model: "codex-extended", effort: "low", workspace: "new" } });
    await page.locator(".welcome").getByRole("button", { name: "New thread", exact: true }).click();
    await page.getByRole("button", { name: "Model: Codex Extended", exact: true }).waitFor();
    assert.equal(requests.filter(event => event.t === "create").at(-1).effort, "low");
    assert.deepEqual(requests.filter(event => event.t === "create").at(-1).workspace, { kind: "new" });
    await page.getByRole("button", { name: "Model: Codex Extended", exact: true }).click();
    await page.getByRole("group", { name: "Model · Provider", exact: true }).getByRole("button", { name: "Claude Code", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Claude Fast/ }).click();
    await page.getByRole("button", { name: "Model: Claude Fast", exact: true }).waitFor();
    await page.locator(".thread-toolbar").getByRole("button", { name: "New thread", exact: true }).click();
    await page.getByRole("button", { name: "Model: Codex Extended", exact: true }).waitFor();
    assert.equal(requests.filter(event => event.t === "create").at(-1).effort, "low");
    emit({ t: "project.upsert", project: { ...projects[0], settings: { provider: "claude", model: "claude-fast", effort: "low", workspace: "current" } } });
    await page.locator(".thread-toolbar").getByRole("button", { name: "New thread", exact: true }).click();
    await page.getByRole("button", { name: "Model: Claude Fast", exact: true }).waitFor();
    assert.equal(requests.filter(event => event.t === "create").at(-1).effort, "low");
    assert.deepEqual(requests.filter(event => event.t === "create").at(-1).workspace, { kind: "current" });
    emit({ t: "project.upsert", project: { ...projects[0], settings: { provider: null, workspace: "current" } } });
    await page.getByRole("button", { name: "Model: Claude Fast", exact: true }).click();
    await page.getByRole("group", { name: "Model · Provider", exact: true }).getByRole("button", { name: "Codex", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Codex Extended/ }).click();
    await page.getByRole("button", { name: /^Model options:/ }).click();
    await page.getByRole("menuitem", { name: /^High/ }).click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("citropy.threadDefaults")).effort === "high");
    await page.locator(".thread-toolbar").getByRole("button", { name: "New thread", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".thread-row").length === 4);
    assert.equal(requests.filter(event => event.t === "create").at(-1).provider, "codex");
    assert.equal(requests.filter(event => event.t === "create").at(-1).effort, "high");
    emit({ t: "project.upsert", project: { ...projects[0], settings: {} } });
    await page.locator(".workspace-select").click();
    await page.getByRole("menuitem", { name: "New thread with workspace options…", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New conversation", exact: true });
    assert.equal(await dialog.getByLabel("Provider").inputValue(), "codex");
    assert.equal(await dialog.getByLabel("Model").inputValue(), "codex-extended");
    assert.equal(await dialog.getByRole("radio", { name: /New worktree/ }).isChecked(), true);
    await dialog.getByRole("button", { name: "Create conversation", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(requests.filter(event => event.t === "create").at(-1).effort, "low");
  });

  await t.test("workspace setup remains available and preserves choices when the provider changes", async test => {
    const { page, requests } = await fixture(test, { chat: false });
    await page.locator(".workspace-select").click();
    await page.getByRole("menuitem", { name: "New thread with workspace options…", exact: true }).click();
    await page.getByRole("dialog", { name: "New conversation", exact: true }).waitFor();
    const provider = page.getByRole("combobox", { name: "Provider", exact: true });
    assert.deepEqual(await provider.locator("option").allTextContents(), ["Claude Code", "Codex", "OpenCode"]);
    await page.getByRole("radio", { name: /New worktree/ }).click();
    await page.getByRole("textbox", { name: "Branch name", exact: true }).fill("feature/check-provider");
    await provider.selectOption("codex");
    await page.getByRole("combobox", { name: "Model", exact: true }).selectOption("codex-extended");
    assert.equal(await page.getByRole("textbox", { name: "Branch name", exact: true }).inputValue(), "feature/check-provider");
    await page.getByRole("button", { name: "Create conversation", exact: true }).click();
    await page.locator(".citropy-dialog").waitFor({ state: "detached" });
    assert.deepEqual(requests.find(event => event.t === "create"), { t: "create", projectId: "first", provider: "codex", model: "codex-extended", workspace: { kind: "new", path: "", branch: "feature/check-provider", base: "HEAD" } });
    await page.locator(".workspace-select").click();
    await page.getByRole("menuitem", { name: /^Second workspace/ }).click();
    await page.locator(".welcome").getByRole("button", { name: "New thread", exact: true }).click();
    await page.getByRole("button", { name: "Model: Codex Extended", exact: true }).waitFor();
  });

  await t.test("model favorites persist, respect provider locks, and keep a steady scrollable picker", async test => {
    const catalogs = providers.map(provider => provider.id === "codex" ? { ...provider, models: [...provider.models, ...Array.from({ length: 40 }, (_, index) => ({ id: `codex-${index}`, label: `Codex model ${index}` }))] } : provider);
    const { page, requests, emit } = await fixture(test, { chat: false, catalogs });
    await page.locator(".welcome").getByRole("button", { name: "New thread", exact: true }).click();
    await page.getByRole("button", { name: "Model: Claude Fast", exact: true }).click();
    const menu = page.getByRole("menu");
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".model-picker-menu")).opacity === "1");
    const initial = await menu.boundingBox();
    assert.deepEqual(await menu.locator(".menu-hint").allTextContents(), ["Claude Code", "Claude Code"]);
    assert.equal(await menu.locator(".menu-hint .provider-icon").count(), 2);
    const providerButtons = page.getByRole("group", { name: "Model · Provider", exact: true });
    assert.deepEqual(await providerButtons.getByRole("button").allTextContents(), ["", "", ""]);
    await providerButtons.getByRole("button", { name: "Codex", exact: true }).click();
    assert.deepEqual(await menu.boundingBox(), initial);
    assert.equal(await menu.locator(".menu-hint").first().textContent(), "Codex");
    assert.equal(await menu.locator(".menu-hint .provider-icon").count(), 42);
    const list = menu.locator(".menu-list");
    assert.equal(await list.evaluate(node => getComputedStyle(node).scrollbarWidth), "none");
    await list.hover();
    await page.mouse.wheel(0, 600);
    await page.waitForFunction(() => document.querySelector(".model-picker-menu .menu-list").scrollTop > 0);
    await list.evaluate(node => { node.scrollTop = 0; });
    await menu.getByRole("button", { name: "Favorite Codex Extended", exact: true }).click();
    assert.equal(await menu.getByRole("button", { name: "Favorite Codex Extended", exact: true }).getAttribute("aria-pressed"), "true");
    await providerButtons.getByRole("button", { name: "Claude Code", exact: true }).click();
    assert.deepEqual(await menu.boundingBox(), initial);
    await menu.getByRole("button", { name: "Favorite Claude Extended", exact: true }).click();
    assert.equal(requests.filter(event => event.t === "thread.config").length, 0);
    await menu.getByRole("button", { name: "Favorite models", exact: true }).click();
    assert.deepEqual(await menu.getByRole("menuitem").locator(".menu-label").allTextContents(), ["Claude Extended", "Codex Extended"]);
    assert.deepEqual(await menu.boundingBox(), initial);
    await page.screenshot({ path: "/tmp/citropy-model-favorites-desktop.png", animations: "disabled" });
    await menu.getByRole("textbox", { name: "Search models", exact: true }).fill("codex");
    assert.deepEqual(await menu.getByRole("menuitem").locator(".menu-label").allTextContents(), ["Codex Extended"]);
    await menu.getByRole("menuitem", { name: /^Codex Extended/ }).click();
    await page.getByRole("button", { name: "Model: Codex Extended", exact: true }).waitFor();
    await page.reload();
    await page.locator(".welcome").getByRole("button", { name: "New thread", exact: true }).click();
    await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
    await page.setViewportSize({ width: 600, height: 800 });
    await page.getByRole("button", { name: "Model: Codex Extended", exact: true }).click();
    await menu.getByRole("button", { name: "Favorite models", exact: true }).click();
    assert.deepEqual(await menu.getByRole("menuitem").locator(".menu-label").allTextContents(), ["Claude Extended", "Codex Extended"]);
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".model-picker-menu")).opacity === "1");
    const narrow = await menu.boundingBox();
    assert.ok(narrow.x >= 0 && narrow.x + narrow.width <= 600 && narrow.y >= 0 && narrow.y + narrow.height <= 800);
    await page.screenshot({ path: "/tmp/citropy-model-favorites-narrow.png", animations: "disabled" });
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
    emit({ t: "thread.upsert", thread });
    await page.locator('.thread-row[aria-label="Current conversation"]').click();
    await page.getByRole("button", { name: "Model: Claude Fast", exact: true }).click();
    await menu.getByRole("button", { name: "Claude Code · Provider locked", exact: true }).waitFor();
    await menu.getByRole("button", { name: "Favorite models", exact: true }).click();
    assert.deepEqual(await menu.getByRole("menuitem").locator(".menu-label").allTextContents(), ["Claude Extended"]);
    await menu.getByRole("menuitem", { name: /^Claude Extended/ }).focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await menu.getByRole("button", { name: "Favorite Claude Extended", exact: true }).evaluate(node => node === document.activeElement), true);
    await page.keyboard.press("Enter");
    await menu.getByText("Star models to find them here.", { exact: true }).waitFor();
    assert.equal(await menu.getByRole("textbox", { name: "Search models", exact: true }).evaluate(node => node === document.activeElement), true);
    assert.equal(await menu.count(), 1);
    await menu.getByRole("button", { name: "Claude Code · Provider locked", exact: true }).click();
    assert.deepEqual(await menu.getByRole("menuitem").locator(".menu-label").allTextContents(), ["Claude Fast", "Claude Extended"]);
  });

  await t.test("Git model selection stays synced with settings and provider cards stay separate", async test => {
    const { page, emit } = await fixture(test);
    let settings = { automaticTitles: true, titleModel: null, commitModel: null };
    const patches = [];
    await page.route("**/api/providers/assistance", route => {
      const patch = route.request().postDataJSON();
      patches.push(patch);
      settings = { ...settings, ...patch };
      return route.fulfill({ json: settings });
    });
    await page.route("**/api/providers/maintenance*", route => route.fulfill({ json: [] }));
    await page.getByRole("button", { name: "Git actions", exact: true }).click();
    const panel = page.locator(".git-panel");
    await panel.getByRole("button", { name: "Commit model: Claude Fast", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Transfer to another agent", exact: true }).count(), 0);
    const provider = page.getByRole("group", { name: "Commit model · Provider", exact: true });
    await provider.getByRole("button", { name: "Codex", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Codex Extended/ }).click();
    await panel.getByRole("button", { name: "Commit model: Codex Extended", exact: true }).waitFor();
    assert.deepEqual(patches, [{ commitModel: { provider: "codex", model: "codex-extended" } }]);
    assert.equal(settings.titleModel, null);
    await panel.getByRole("button", { name: "Commit model: Codex Extended", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "detached" });
    assert.equal(await panel.count(), 1);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "AI assistance", exact: true }).click();
    await page.getByRole("button", { name: "Commit model: Codex Extended", exact: true }).waitFor();
    await page.getByRole("button", { name: "Providers", exact: true }).click();
    for (const width of [1440, 600]) {
      await page.setViewportSize({ width, height: 1000 });
      if (width === 600) {
        await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
        await page.locator(".section-rail").waitFor({ state: "detached" });
      }
      const cards = await page.locator(".provider-card").evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }));
      assert.equal(cards.length, 3);
      assert.ok(cards[1].top - cards[0].bottom >= 15);
      assert.ok(cards[2].top - cards[1].bottom >= 15);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: `/tmp/citropy-provider-cards-${width}.png`, animations: "disabled" });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
    await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    await panel.getByRole("button", { name: "Commit model: Codex Extended", exact: true }).waitFor();
    await panel.getByRole("button", { name: "Hide Git panel", exact: true }).click();
    await panel.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Model: Claude Fast", exact: true }).click();
    await page.getByRole("button", { name: "Claude Code · Provider locked", exact: true }).waitFor();
    assert.equal(await page.getByRole("group", { name: "Model · Provider", exact: true }).count(), 0);
    assert.equal(await page.getByRole("combobox", { name: "Model · Provider", exact: true }).count(), 0);
    await page.getByRole("menuitem", { name: /^Claude Extended/ }).click();
    await page.getByRole("button", { name: "Model: Claude Extended", exact: true }).waitFor();
    await page.getByRole("button", { name: "Model: Claude Extended", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "detached" });
    const surfaces = await page.locator(".composer-shell, .agent-card").evaluateAll(nodes => nodes.map(node => {
      const style = getComputedStyle(node);
      return {
        borderless: ["Top", "Right", "Bottom", "Left"].every(side => parseFloat(style[`border${side}Width`]) === 0 || style[`border${side}Color`] === "rgba(0, 0, 0, 0)"),
        background: style.backgroundColor,
        canvas: getComputedStyle(document.body).backgroundColor,
        outline: style.outlineStyle,
      };
    }));
    assert.ok(surfaces.length > 0 && surfaces.every(style => style.borderless && style.outline === "none" && style.background !== style.canvas));
    emit({ t: "thread.upsert", thread: { ...thread, id: "pinned", title: "Pinned example", pinned: true } });
    for (const width of [1440, 600]) {
      await page.setViewportSize({ width, height: 1000 });
      if (width > 720) await page.locator(".canvas").click();
      await page.screenshot({ path: `/tmp/citropy-chat-refined-${width}.png`, animations: "disabled" });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
  });

  await t.test("chat transfers require an explicit usage confirmation and preserve the draft and agent identities", async test => {
    const { page, requests, emit } = await fixture(test);
    let fail = false;
    await page.route("**/api/threads/transfer?*", route => {
      const input = route.request().postDataJSON();
      requests.push({ t: "transfer", threadId: new URL(route.request().url()).searchParams.get("threadId"), ...input });
      if (fail) return route.fulfill({ status: 400, json: { error: "Transfer fixture failed" } });
      emit({ t: "thread.messages", threadId: "chat", messages: [{ id: "reply", provider: "claude", model: "claude-fast", role: "assistant", ts: 1, parts: [{ id: "reply-text", kind: "text", text: "Your changes are ready to review.", complete: true }] }] });
      emit({ t: "thread.upsert", thread: { ...thread, ...input, externalId: undefined, running: true, status: "thinking", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, contextTokens: 0, contextMax: 0, turns: 0 }, transfers: [{ provider: thread.provider, model: thread.model, usage: thread.usage, at: 2 }] } });
      return route.fulfill({ json: { ok: true } });
    });
    const draft = page.getByRole("textbox", { name: "Message", exact: true });
    await draft.fill("Keep this unsent draft.");
    for (const width of [1440, 420]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 420) {
        await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
        await page.locator(".rail").waitFor({ state: "detached" });
      }
      await page.locator(".composer-model").click();
      const menu = page.getByRole("menu");
      assert.equal(await menu.getByRole("button", { name: "Codex", exact: true }).count(), 0);
      await menu.getByRole("button", { name: "Transfer to another agent", exact: true }).click();
      await menu.getByText("Choose a model for a new agent in this chat. Reading the conversation again consumes extra usage.", { exact: true }).waitFor();
      assert.equal(await menu.getByRole("menuitem", { name: /^Claude Fast/ }).isDisabled(), true);
      await menu.getByRole("button", { name: "Codex", exact: true }).click();
      await page.screenshot({ path: `/tmp/citropy-transfer-picker-${width}.png`, animations: "disabled" });
      await menu.getByRole("menuitem", { name: /^Codex Extended/ }).click();
      const dialog = page.getByRole("dialog", { name: "Transfer to Codex Extended?", exact: true });
      await dialog.waitFor();
      assert.match(await dialog.textContent(), /extra usage.*additional costs/);
      assert.equal(requests.filter(event => event.t === "transfer").length, 0);
      const bounds = await dialog.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 0 && bounds.y + bounds.height <= 900, JSON.stringify(bounds));
      await page.screenshot({ path: `/tmp/citropy-transfer-confirm-${width}.png`, animations: "disabled" });
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      assert.equal(await draft.inputValue(), "Keep this unsent draft.");
    }
    const choose = async () => {
      await page.locator(".composer-model").click();
      await page.getByRole("button", { name: "Transfer to another agent", exact: true }).click();
      await page.getByRole("button", { name: "Codex", exact: true }).click();
      await page.getByRole("menuitem", { name: /^Codex Extended/ }).click();
      await page.getByRole("button", { name: "Transfer and continue", exact: true }).click();
    };
    fail = true;
    await choose();
    await page.getByText("Transfer fixture failed", { exact: true }).waitFor();
    assert.equal(await page.locator(".composer-model").isEnabled(), true);
    assert.equal(await draft.inputValue(), "Keep this unsent draft.");
    fail = false;
    await choose();
    await page.getByRole("button", { name: "Model: Codex Extended", exact: true }).waitFor();
    assert.equal(await page.locator(".composer-model").isDisabled(), true);
    assert.equal(await draft.inputValue(), "Keep this unsent draft.");
    assert.equal(await page.locator(".turn-agent .turn-provider").first().textContent(), "Claude Code");
    assert.equal(await page.locator(".turn-agent .turn-heading strong").first().textContent(), "Claude Fast");
    assert.deepEqual(requests.filter(event => event.t === "transfer"), [1, 2].map(() => ({ t: "transfer", threadId: "chat", provider: "codex", model: "codex-extended" })));
    assert.equal(requests.some(event => event.t === "thread.config" || event.t === "create"), false);
    await page.locator(".context-ring").hover();
    assert.equal(await page.locator(".context-totals summary strong").textContent(), "384k");
  });

  await t.test("notifications stay reachable beside the sidebar controls at every window size", async test => {
    const { page } = await fixture(test);
    const sidebar = page.getByRole("button", { name: "Toggle sidebar", exact: true });
    for (const platform of ["linux", "darwin"]) {
      await page.evaluate(platform => document.documentElement.dataset.platform = platform, platform);
      for (const width of [1440, 900, 600, 420]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const open of [false, true]) {
          if ((await sidebar.getAttribute("aria-expanded") === "true") !== open) await sidebar.click();
          await page.getByRole("button", { name: "Notifications", exact: true }).click();
          const panel = page.getByRole("dialog", { name: "Notifications", exact: true });
          await page.waitForFunction(() => getComputedStyle(document.querySelector(".notification-center")).opacity === "1");
          const bounds = await panel.boundingBox();
          assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, `${platform} notifications overflow at ${width}px`);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          if (!open) await page.keyboard.press("Escape");
          else await page.mouse.click(width - 4, 600);
          await panel.waitFor({ state: "detached" });
        }
      }
    }
  });

  await t.test("dialogs and popovers finish closing and respect reduced motion", async test => {
    const { page } = await fixture(test);
    await page.locator(".workspace-select").click();
    await page.getByRole("menuitem", { name: "New thread with workspace options…", exact: true }).click();
    const dialog = page.locator(".citropy-dialog");
    await dialog.waitFor();
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".citropy-dialog")).opacity === "1");
    await page.getByRole("button", { name: "Cancel", exact: true }).evaluate(button => button.click());
    await page.waitForFunction(() => { const node = document.querySelector('.citropy-dialog[data-exiting]'); return node?.inert && !node.open && getComputedStyle(node).display !== "none" && Number(getComputedStyle(node).opacity) < 1; });
    await dialog.waitFor({ state: "detached" });
    const toggle = page.getByRole("button", { name: "Git actions", exact: true });
    for (const [open, close, selector] of [["Git actions", "Hide Git panel", ".git-panel"], ["Notifications", "Close notifications", ".notification-center"]]) {
      await page.getByRole("button", { name: open, exact: true }).click();
      await page.waitForFunction(selector => {
        const panel = document.querySelector(selector);
        return panel && getComputedStyle(panel).opacity === "1";
      }, selector);
      const closing = await page.getByRole("button", { name: close, exact: true }).evaluate(async (button, selector) => {
        const panel = document.querySelector(selector);
        button.click();
        await new Promise(resolve => {
          const deadline = performance.now() + 500;
          const closing = () => {
            if (!panel.isConnected || getComputedStyle(panel).pointerEvents === "none" || performance.now() >= deadline) resolve();
            else requestAnimationFrame(closing);
          };
          requestAnimationFrame(closing);
        });
        return { present: panel.isConnected, pointerEvents: getComputedStyle(panel).pointerEvents };
      }, selector);
      assert.deepEqual(closing, { present: true, pointerEvents: "none" });
      await page.locator(selector).waitFor({ state: "detached" });
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await toggle.click();
    await page.locator(".git-panel").waitFor();
    await page.getByRole("button", { name: "Hide Git panel", exact: true }).click();
    await page.locator(".git-panel").waitFor({ state: "detached" });
    await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== "running"));
  });

  await t.test("source control and GitHub switch workspaces without returning to chat", async test => {
    const { page, requests, states } = await fixture(test);
    await page.getByRole("button", { name: "Source control", exact: true }).click();
    await page.getByRole("button", { name: "Stage all", exact: true }).waitFor();
    assert.equal(await page.getByText("Local workspace", { exact: true }).count(), 0);
    assert.equal(await page.locator(".git-footer").count(), 0);
    await page.locator(".workspace-select").click();
    await page.getByRole("menuitem", { name: /^Second workspace/ }).click();
    await page.getByRole("button", { name: "Choose workspace, Second workspace", exact: true }).waitFor();
    await page.getByRole("heading", { name: "src/second.ts", exact: true }).waitFor();
    for (const width of [1440, 960]) {
      await page.setViewportSize({ width, height: 1000 });
      if (width === 960) await page.getByRole("button", { name: "Back to changed files", exact: true }).click();
      const visible = await page.getByRole("button", { name: "Stage all", exact: true }).evaluate(node => {
        const rect = node.getBoundingClientRect();
        return rect.width > 70 && rect.height > 25 && node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      });
      assert.equal(visible, true);
      await page.screenshot({ path: `/tmp/citropy-source-control-${width}.png`, animations: "disabled" });
    }
    await page.getByRole("button", { name: "Stage all", exact: true }).click();
    await page.getByRole("button", { name: "Unstage all", exact: true }).waitFor();
    assert.equal(requests.findLast(event => event.operation === "stageAll").projectId, "second");
    assert.equal(states.first.status.files[0].staged, false);
    assert.equal(states.second.status.files[0].staged, true);
    await page.getByRole("button", { name: "GitHub", exact: true }).click();
    await page.locator(".github-sidebar-repo strong").getByText("example/second", { exact: true }).waitFor();
    await page.locator(".workspace-select").click();
    await page.getByRole("menuitem", { name: /^First workspace/ }).click();
    await page.locator(".github-sidebar-repo strong").getByText("example/first", { exact: true }).waitFor();
    assert.equal(requests.findLast(event => event.t === "github.request" && event.request.operation === "status").request.projectId, "first");
    await page.screenshot({ path: "/tmp/citropy-github-workspace.png", animations: "disabled" });
  });

  await t.test("irregular context limits stay compact, explain their exact capacity, and keep effort on one line", async test => {
    const catalogs = [{ ...providers[2], models: [{ id: "muse", label: "Muse Spark 1.3 Free", efforts: ["xhigh"], defaultEffort: "xhigh", contextMax: 1048576 }] }];
    const { page, emit } = await fixture(test, { catalogs });
    emit({ t: "thread.upsert", thread: { ...thread, provider: "opencode", model: "muse", effort: "xhigh", contextWindow: 1048576 } });
    const options = page.getByRole("button", { name: "Model options: Extra high, 1.05M context", exact: true });
    await options.waitFor();
    assert.equal(await options.locator(".composer-context").textContent(), "1.05M");
    assert.equal(await options.locator(".composer-context").getAttribute("title"), "Context window: 1,048,576 tokens");
    for (const width of [1440, 700, 420]) {
      await page.setViewportSize({ width, height: 900 });
      const text = await options.locator("span").first().evaluate(node => ({ height: node.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(node).lineHeight) * 1.2 }));
      assert.ok(text.height < text.lineHeight + 1, JSON.stringify(text));
      assert.ok(await options.evaluate(node => node.scrollWidth <= node.clientWidth));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
  });

  await t.test("context hover crosses into the panel, never latches on click, and uses reported capacity during the first turn", async test => {
    const { page, emit } = await fixture(test);
    for (const width of [1440, 600]) {
      await page.setViewportSize({ width, height: 1000 });
      if (width === 600) {
        await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
        await page.locator(".rail").waitFor({ state: "detached" });
      }
      const meter = page.getByRole("button", { name: "41% context used", exact: true });
      await meter.hover();
      const panel = page.getByRole("group", { name: "Context usage", exact: true });
      await panel.waitFor();
      await page.waitForFunction(() => getComputedStyle(document.querySelector(".context-details")).opacity === "1");
      assert.equal(await panel.evaluate(node => node.matches(":popover-open")), true);
      await page.screenshot({ path: `/tmp/citropy-context-hover-${width}.png`, animations: "disabled" });
      const box = await panel.boundingBox();
      const ring = await meter.boundingBox();
      await page.mouse.move(ring.x + ring.width / 2, box.y + box.height + 4);
      await page.waitForTimeout(240);
      assert.equal(await panel.isVisible(), true);
      await panel.getByRole("button", { name: "Compact context", exact: true }).hover();
      assert.equal(await panel.isVisible(), true);
      assert.ok(box.x >= 0 && box.x + box.width <= width);
      await meter.click();
      await page.mouse.move(width / 2, 200);
      await panel.waitFor({ state: "detached" });
      await page.getByLabel("Message", { exact: true }).focus();
      for (let index = 0; index < 15; index++) {
        await page.keyboard.press("Tab");
        if (await meter.evaluate(node => node === document.activeElement)) break;
      }
      assert.equal(await meter.evaluate(node => node === document.activeElement), true);
      await panel.waitFor();
      await page.keyboard.press("Escape");
      await panel.waitFor({ state: "detached" });
      for (let index = 0; index < 5; index++) {
        await meter.hover();
        await page.mouse.move(width / 2, 200);
        await meter.hover();
      }
      await panel.getByRole("button", { name: "Compact context", exact: true }).hover();
      await page.mouse.move(width / 2, 200);
      await panel.waitFor({ state: "detached" });
    }
    emit({ t: "thread.upsert", thread: { ...thread, running: true, contextWindow: 1000000, usage: { ...thread.usage, turns: 0 } } });
    await page.getByRole("button", { name: "41% context used", exact: true }).hover();
    await page.getByText("82k of 200k tokens", { exact: true }).waitFor();
    await page.getByText("Total processed", { exact: true }).waitFor();
    emit({ t: "thread.upsert", thread: { ...thread, externalId: undefined, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, contextTokens: 0, contextMax: 0, turns: 0 }, contextWindow: 1000000 } });
    await page.getByRole("button", { name: "0% context used", exact: true }).waitFor();
    assert.equal(await page.locator(".context-ring text").textContent(), "0");
  });

  await t.test("context meters distinguish missing usage from empty threads and never count cache twice", async test => {
    const { page, emit } = await fixture(test);
    const panel = page.getByRole("group", { name: "Context usage", exact: true });
    for (const contextTokens of [0, 44200000]) {
      emit({ t: "thread.upsert", thread: { ...thread, usage: { input: 1662, output: 253163, cacheRead: 72274757, cacheWrite: 1446282, costUsd: 56.94, contextTokens, contextMax: 1000000, turns: 18 } } });
      await page.locator(".context-ring").hover();
      await panel.getByText("Not reported yet", { exact: true }).waitFor();
      assert.equal(await page.locator(".context-ring text").textContent(), "");
      assert.equal(await panel.getByText("Window size: 1.00M tokens", { exact: true }).isVisible(), true);
      assert.equal(await panel.getByText("Total processed", { exact: true }).isVisible(), true);
      assert.equal(await panel.getByText("Uncached input", { exact: true }).isVisible(), false);
      await page.mouse.move(600, 200);
      await panel.waitFor({ state: "detached" });
    }
    for (const provider of ["claude", "codex", "opencode"]) {
      emit({ t: "thread.upsert", thread: { ...thread, provider, usage: { input: provider === "codex" ? 1300 : 200, output: 300, cacheRead: 1000, cacheWrite: 100, costUsd: 0, contextTokens: 60000, contextMax: 1000000, turns: 2 } } });
      await page.getByRole("button", { name: "6% context used", exact: true }).hover();
      await panel.getByText("60k of 1.00M tokens", { exact: true }).waitFor();
      assert.equal(await panel.locator("summary strong").textContent(), "1.6k");
      await panel.locator("summary").click();
      assert.equal(await panel.locator("dl > div").filter({ has: page.getByText("Uncached input", { exact: true }) }).locator("dd").textContent(), "200");
      assert.equal(await panel.locator("dl > div").filter({ has: page.getByText("Cache read", { exact: true }) }).locator("dd").textContent(), "1k");
      await page.keyboard.press("Escape");
      await panel.waitFor({ state: "detached" });
    }
  });

  await t.test("compaction has one conversation status and a spaced usage action", async test => {
    const { page, requests, emit } = await fixture(test);
    const compacting = { ...thread, compacting: true, running: true, status: "working", activeTool: "Compacting context" };
    emit({ t: "thread.upsert", thread: compacting });
    await page.locator(".working-text").getByText("Compacting context", { exact: true }).waitFor();
    assert.equal(await page.locator(".composer-shell .upload-progress").count(), 0);
    assert.equal(await page.getByText("Running Compacting context", { exact: true }).count(), 0);
    for (const width of [1440, 960]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.getByRole("button", { name: "41% context used", exact: true }).click();
      await page.locator(".context-compacting").waitFor();
      assert.equal(await page.locator(".context-details").getByRole("button", { name: /Compact/ }).count(), 0);
      await page.screenshot({ path: `/tmp/citropy-compaction-${width}.png`, animations: "disabled" });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    emit({ t: "thread.upsert", thread });
    await page.getByRole("button", { name: "41% context used", exact: true }).hover();
    const compact = page.getByRole("button", { name: "Compact context", exact: true });
    await compact.waitFor();
    await page.locator(".context-totals summary").click();
    const action = await compact.boundingBox();
    const stats = await page.locator(".context-details dl").boundingBox();
    assert.equal(await page.locator(".context-connection").count(), 0);
    assert.ok(action.y - stats.y - stats.height >= 12);
    await compact.click();
    await page.locator(".context-compacting").waitFor();
    assert.deepEqual(requests.filter(event => event.t === "compact"), [{ t: "compact", threadId: "chat" }]);
    assert.equal(await page.locator(".working-text").textContent(), "Compacting context");
  });

  await t.test("language changes immediately, persists, and preserves conversation content", async test => {
    const { page } = await fixture(test);
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Keep my draft: source.ts /compact @review");
    await page.locator('.navigation-actions [data-tone="settings"]').click();
    const language = page.locator(".setting-row select").first();
    assert.equal(await language.inputValue(), "en");
    await language.selectOption("es");
    await page.waitForFunction(() => document.documentElement.lang === "es");
    assert.equal(await page.evaluate(() => localStorage.getItem("citropy.language")), "es");
    await page.getByText("Elige el idioma que se usa en Citropy.", { exact: true }).waitFor();
    for (const width of [1440, 960]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.screenshot({ path: `/tmp/citropy-language-general-${width}.png`, animations: "disabled" });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.locator('.section-link[data-settings-section="browser"]').click();
      await page.locator(".settings-heading h1").getByText("Navegador", { exact: true }).waitFor();
      const workspace = page.locator(".feature-field select").first();
      const style = await workspace.evaluate(node => {
        const css = getComputedStyle(node);
        return { appearance: css.appearance, padding: parseFloat(css.paddingRight), background: css.backgroundImage };
      });
      assert.equal(style.appearance, "none");
      assert.ok(style.padding >= 36);
      assert.match(style.background, /data:image\/svg\+xml/);
      await page.screenshot({ path: `/tmp/citropy-language-browser-${width}.png`, animations: "disabled" });
      await page.locator('.section-link[data-settings-section="general"]').click();
    }
    await page.getByRole("button", { name: "Volver al chat", exact: true }).click();
    assert.equal(await page.getByRole("textbox", { name: "Mensaje", exact: true }).inputValue(), "Keep my draft: source.ts /compact @review");
    await page.getByText("Your changes are ready to review.", { exact: true }).waitFor();
    await page.locator('.navigation-actions [data-tone="git"]').click();
    await page.locator(".git-heading h1").getByText("Cambios", { exact: true }).waitFor();
    await page.screenshot({ path: "/tmp/citropy-language-git.png", animations: "disabled" });
    await page.locator('.navigation-actions [data-tone="settings"]').click();
    await page.locator(".setting-row select").first().selectOption("en");
    await page.waitForFunction(() => document.documentElement.lang === "en");
    await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue(), "Keep my draft: source.ts /compact @review");
    await page.locator('.navigation-actions [data-tone="settings"]').click();
    await page.locator(".setting-row select").first().selectOption("es");
    await page.reload();
    await page.waitForFunction(() => document.documentElement.lang === "es");
    await page.getByRole("textbox", { name: "Mensaje", exact: true }).waitFor();
    await page.getByText("Your changes are ready to review.", { exact: true }).waitFor();
  });
});
