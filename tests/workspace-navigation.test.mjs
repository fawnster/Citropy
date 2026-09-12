import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

const projects = [
  { id: "first", name: "First workspace", path: "/example/first", isGit: true, lastOpened: 1 },
  { id: "second", name: "Second workspace", path: "/example/second", isGit: true, lastOpened: 1, settings: { provider: "codex", model: "codex-extended" } },
];
const providers = [
  { id: "claude", label: "Claude Code", available: true, enabled: true, models: [{ id: "claude-fast", label: "Claude Fast", isDefault: true }, { id: "claude-extended", label: "Claude Extended" }] },
  { id: "codex", label: "Codex", available: true, enabled: true, models: [{ id: "codex-fast", label: "Codex Fast", isDefault: true }, { id: "codex-extended", label: "Codex Extended" }] },
  { id: "opencode", label: "OpenCode", available: true, enabled: true, models: [{ id: "open-fast", label: "OpenCode Fast", isDefault: true }] },
];
const thread = { id: "chat", projectId: "first", provider: "claude", model: "claude-fast", title: "Current conversation", permissionMode: "manual", status: "idle", running: false, externalId: "session", createdAt: 1, updatedAt: 1, usage: { input: 280000, output: 1900, cacheRead: 100000, cacheWrite: 2000, costUsd: 4.3, contextTokens: 82000, contextMax: 200000, turns: 4 } };
const account = { login: "example", avatar_url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'/%3E", html_url: "https://github.com/example" };

test("workspace navigation and conversation setup stay consistent", { timeout: 90_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-navigation-"));
  const server = await createServer({ configFile: false, cacheDir: join(directory, "cache"), root: fileURLToPath(new URL("..", import.meta.url)), plugins: [react()], logLevel: "error", server: { host: "127.0.0.1", port: 0, watch: null } });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await rm(directory, { recursive: true, force: true }); });

  async function fixture(test, { chat = true } = {}) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(7000);
    const errors = [];
    const requests = [];
    let connection;
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
      return route.fulfill({ json: { ...thread, ...input, id: "created", title: "New conversation", running: false } });
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
        if (event.t === "thread.load") socket.send(JSON.stringify({ t: "thread.messages", threadId: event.id, messages: event.id === "chat" ? [{ id: "reply", role: "assistant", ts: 1, parts: [{ id: "reply-text", kind: "text", text: "Your changes are ready to review.", complete: true }] }] : [] }));
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
      socket.send(JSON.stringify({ t: "hello", snapshot: { projects, threads: chat ? [thread] : [], providers, permissions: [], home: "/example" } }));
    });
    await page.goto(server.resolvedUrls.local[0]);
    await page.getByRole("button", { name: "Choose workspace, First workspace", exact: true }).waitFor();
    return { page, requests, states, emit: event => connection.send(JSON.stringify(event)) };
  }

  await t.test("workspace actions and pinned, active, and finished categories are distinct", async test => {
    const { page, emit } = await fixture(test);
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
    assert.equal(await active.locator(".thread-card").count(), 0);
    await activeToggle.click();
    await active.getByText("Current conversation", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Finished 1", exact: true }).locator("svg.category-icon").count(), 1);
    await page.getByRole("button", { name: "Finished 1", exact: true }).click();
    await page.getByText("Finished conversation", { exact: true }).waitFor();
    assert.deepEqual(await page.locator(".thread-category").evaluateAll(nodes => nodes.map(node => node.dataset.category)), ["pinned", "active", "finished"]);
    const borders = await page.locator('.thread-category:not(:first-child) > .finished-toggle').evaluateAll(nodes => nodes.map(node => parseFloat(getComputedStyle(node).borderTopWidth)));
    assert.equal(borders.length, 2);
    assert.ok(borders[0] > 0);
    assert.equal(borders[0], borders[1]);
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

  await t.test("both new-thread buttons offer provider choice and preserve workspace choices when it changes", async test => {
    const { page, requests } = await fixture(test, { chat: false });
    assert.equal(await page.locator(".welcome .pill, .welcome .status-dot").count(), 0);
    for (const container of [".thread-toolbar", ".welcome"]) {
      await page.locator(container).getByRole("button", { name: "New thread", exact: true }).click();
      await page.getByRole("dialog", { name: "New conversation", exact: true }).waitFor();
      const provider = page.getByRole("combobox", { name: "Provider", exact: true });
      assert.deepEqual(await provider.locator("option").allTextContents(), ["Claude Code", "Codex", "OpenCode"]);
      assert.equal(await provider.evaluate(node => node === document.activeElement), true);
      await page.getByRole("radio", { name: /New worktree/ }).click();
      await page.getByRole("textbox", { name: "Branch name", exact: true }).fill("feature/check-provider");
      await provider.selectOption("codex");
      await page.getByRole("combobox", { name: "Model", exact: true }).selectOption("codex-extended");
      assert.equal(await page.getByRole("textbox", { name: "Branch name", exact: true }).inputValue(), "feature/check-provider");
      for (const width of [1440, 960]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.screenshot({ path: `/tmp/citropy-new-thread-${width}.png`, animations: "disabled" });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      }
      if (container === ".thread-toolbar") {
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await page.screenshot({ path: "/tmp/citropy-start-screen.png", animations: "disabled" });
      } else {
    await page.getByRole("button", { name: "Create conversation", exact: true }).click();
        await page.getByRole("dialog").waitFor({ state: "detached" });
        assert.deepEqual(requests.find(event => event.t === "create"), { t: "create", projectId: "first", provider: "codex", model: "codex-extended", workspace: { kind: "new", path: "", branch: "feature/check-provider", base: "HEAD" } });
      }
    }
    await page.locator(".workspace-select").click();
    await page.getByRole("menuitem", { name: /^Second workspace/ }).click();
    await page.locator(".welcome").getByRole("button", { name: "New thread", exact: true }).click();
    assert.equal(await page.getByRole("combobox", { name: "Provider", exact: true }).inputValue(), "codex");
    assert.equal(await page.getByRole("combobox", { name: "Model", exact: true }).inputValue(), "codex-extended");
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
    const compact = page.getByRole("button", { name: "Compact context", exact: true });
    await compact.waitFor();
    const action = await compact.boundingBox();
    const stats = await page.locator(".context-details dl").boundingBox();
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
