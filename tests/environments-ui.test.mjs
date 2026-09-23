import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

test("grouped workspaces switch hosts without reloading and use the system folder dialog", { timeout: 120000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-environments-ui-"));
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), plugins: [react()], logLevel: "error", cacheDir: join(directory, "cache"), server: { host: "127.0.0.1", port: 0, watch: null } });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20000);
  const errors = [];
  const messages = [];
  let defaults = { provider: "opencode", model: "remote/model", effort: "high", permissionMode: "plan" };
  const defaultsSaved = [];
  await page.exposeFunction("saveProjectDefaults", settings => {
    defaultsSaved.push(settings);
    defaults = settings;
    return settings;
  });
  const threadRequested = Promise.withResolvers();
  let heldLocalMessage = false;
  let navigations = 0;
  page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations++; });
  page.on("pageerror", error => errors.push(error.message));
  t.after(async () => { await browser.close(); await server.close(); await rm(directory, { recursive: true, force: true }); });
  await page.addInitScript(() => {
    if (!localStorage.getItem("test.seeded")) {
      const prefs = { project: "local-project", thread: "task", inspector: "0", theme: "dark", uiScale: "120", offline: JSON.stringify({ task: [{ id: "held", text: "LOCAL MESSAGE", attachments: [], createdAt: 1 }] }) };
      for (const [key, value] of Object.entries(prefs)) localStorage.setItem(`citropy.${key}`, value);
      localStorage.setItem("citropy.draft.task", JSON.stringify({ text: "LOCAL DRAFT", attachments: [] }));
      localStorage.setItem("citropy.environment.ssh-test.citropy.offline", JSON.stringify({ task: [{ id: "held", text: "REMOTE MESSAGE", attachments: [], createdAt: 1 }] }));
      localStorage.setItem("test.seeded", "1");
    }
    const connection = { id: "ssh-test", name: "Build server", target: "dev@buildbox", port: 22, node: "node", status: "connected" };
    let activeId = localStorage.getItem("test.environment") || "local";
    if (activeId === "local") connection.status = "disconnected";
    const listeners = new Set();
    window.environmentListenerCount = () => listeners.size;
    window.folderChoices = [];
    window.folderListings = [];
    window.nextFolder = "/home/dev/projects";
    const state = () => ({ activeId, endpoint: activeId === "local" ? "" : "http://127.0.0.1:49121", connections: [{ ...connection }] });
    const emit = () => { for (const listener of listeners) listener(state()); };
    window.citropyDesktop = {
      environmentsState: async () => state(),
      sshHosts: async () => ["buildbox", "staging"],
      onEnvironmentsState: callback => { listeners.add(callback); return () => listeners.delete(callback); },
      connectEnvironment: async id => { activeId = id; connection.status = "connected"; localStorage.setItem("test.environment", id); emit(); return { ...state(), connections: [{ ...connection, name: `${connection.name} (applied)` }] }; },
      disconnectEnvironment: async () => { connection.status = "disconnected"; emit(); },
      saveEnvironment: async input => ({ ...input, id: "new-ssh" }),
      configureProjectDefaults: settings => window.saveProjectDefaults(settings),
      removeEnvironment: async () => {},
      chooseWorkspaceFolder: async id => { window.folderChoices.push(id); return window.nextFolder; },
      listWorkspaceFolder: async (id, path) => {
        window.folderListings.push([id, path]);
        const tree = {
          "/home/dev": { parent: "/home", folders: [{ name: ".cache", hidden: true }, { name: "projects", hidden: false }] },
          "/home/dev/projects": { parent: "/home/dev", folders: [{ name: "app", hidden: false }] },
          "/home/dev/projects/app": { parent: "/home/dev/projects", folders: [] },
          "/home/dev/projects/app ": { parent: "/home/dev/projects", folders: [] },
        };
        const resolved = path === "" || path === "~" ? "/home/dev" : path;
        if (!tree[resolved]) throw new Error("Error invoking remote method 'environments:list-folder': Error: That folder does not exist on the SSH host or cannot be opened.");
        return { path: resolved, ...tree[resolved] };
      },
      windowState: async () => ({ platform: "linux", maximized: false, fullscreen: false, development: true, version: "test", notifications: false, electron: "test" }),
      onWindowState: () => () => {},
      onNotification: () => () => {},
      onBrowserSelect: () => () => {},
      updateState: async () => ({ status: "idle", version: "test" }),
      onUpdateState: () => () => {},
    };
  });
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    assert.notEqual(url.pathname, "/api/remote/folders");
    assert.notEqual(url.pathname, "/api/projects/defaults");
    if (url.pathname === "/api/threads") { threadRequested.resolve(route); return; }
    const data = {};
    await route.fulfill({ json: data, headers: { "access-control-allow-origin": "*" } });
  });
  await page.routeWebSocket("**/socket", socket => {
    const remote = socket.url().includes(":49121/");
    const projectId = remote ? "remote-project" : "local-project";
    socket.onMessage(raw => {
      const event = JSON.parse(raw);
      messages.push({ remote, ...event });
      if (event.t === "thread.load") socket.send(JSON.stringify({ t: "thread.messages", threadId: "task", messages: [{ id: "answer", role: "assistant", ts: 1, parts: [{ id: "text", kind: "text", text: remote ? "REMOTE RESPONSE" : "LOCAL RESPONSE", complete: true }] }] }));
      if (event.t === "github.request") socket.send(JSON.stringify({ t: "github.result", requestId: event.requestId, result: { installed: false } }));
      if (event.t === "thread.send") {
        if (!remote && event.text === "LOCAL MESSAGE" && !heldLocalMessage) { heldLocalMessage = true; return; }
        socket.send(JSON.stringify({ t: "thread.accepted", requestId: event.requestId }));
      }
      if (event.t === "git.refresh") socket.send(JSON.stringify({ t: "git.status", projectId, threadId: "task", status: { branch: "main", upstream: "origin/main", ahead: 0, behind: 0, clean: true, files: [] } }));
      if (event.t === "project.choose") socket.send(JSON.stringify({ t: "project.chosen", projectId }));
    });
    socket.send(JSON.stringify({ t: "hello", snapshot: {
      projectDefaults: defaults,
      projects: [{ id: projectId, path: remote ? "/home/dev/project" : "/local/project", name: remote ? "Remote project" : "Local project", isGit: true, lastOpened: 1 }],
      threads: [{ id: "task", projectId, provider: "claude", model: "test", title: "A task", createdAt: 1, updatedAt: 1, running: false, status: "idle", permissionMode: "manual", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, contextTokens: 0, contextMax: 200000, turns: 0 } }],
      providers: [{ id: "claude", label: "Claude Code", available: true, enabled: true, models: [{ id: "test", label: "Example model" }] }],
      permissions: [], home: remote ? "/home/dev" : "/local", shells: [{ id: "shell", projectId, threadId: "task", command: "npm run dev", cwd: "/project", status: "running", background: true, stopMode: "shell", output: "Server ready", startedAt: 1 }],
    } }));
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByText("LOCAL RESPONSE", { exact: true }).waitFor();
  await page.evaluate(async () => {
    const actions = await import("/web/src/lib/actions.ts");
    window.oldCreate = actions.createThread();
    window.oldRead = actions.fetchFile("local-project", "delayed.txt").then(() => "accepted", error => error.name);
  });
  const delayedThread = await threadRequested.promise;
  await page.getByRole("button", { name: "Git actions", exact: true }).waitFor();
  assert.equal(await page.locator(".shells-trigger").count(), 1);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator("button[data-settings-section='environments']").click();
  await page.getByRole("button", { name: "Git actions", exact: true }).click();
  await page.getByRole("dialog", { name: "Git actions", exact: true }).waitFor();
  await page.getByRole("button", { name: "Hide Git panel", exact: true }).click();
  await page.getByRole("button", { name: "Add connection", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Connect over SSH", exact: true });
  await dialog.waitFor();
  await dialog.getByLabel("SSH host", { exact: true }).fill("dev@buildbox");
  for (const width of [1440, 620]) {
    await page.setViewportSize({ width, height: 900 });
    const box = await dialog.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width + 1, JSON.stringify({ width, box }));
    assert.ok(box.y >= 0 && box.y + box.height <= 900);
    await page.screenshot({ path: `/tmp/citropy-ssh-connect-${width}.png`, animations: "disabled" });
  }
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: "/tmp/citropy-ssh-settings.png", animations: "disabled" });
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: "Disconnect", exact: true }).waitFor();
  assert.equal(await page.locator("h1[data-settings-section='environments']").count(), 1);
  await page.getByRole("button", { name: "Back to chat", exact: true }).click();
  await page.getByText("REMOTE RESPONSE", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator("button[data-settings-section='projects']").click();
  const globalDefaults = page.getByRole("region", { name: "Global defaults", exact: true });
  assert.equal(await globalDefaults.getByRole("combobox", { name: /^Permissions/ }).inputValue(), "plan");
  assert.equal(await globalDefaults.getByRole("combobox", { name: /^Reasoning effort/ }).inputValue(), "high");
  assert.match(await globalDefaults.locator(".model-picker-trigger").innerText(), /remote\/model/);
  await globalDefaults.getByRole("combobox", { name: /^Permissions/ }).selectOption("acceptEdits");
  await globalDefaults.getByRole("button", { name: "Save global defaults", exact: true }).click();
  await globalDefaults.getByText("Global defaults saved", { exact: true }).waitFor();
  assert.deepEqual(defaultsSaved, [{ provider: "opencode", model: "remote/model", effort: "high", permissionMode: "acceptEdits" }]);
  await page.getByRole("button", { name: "Back to chat", exact: true }).click();
  await delayedThread.fulfill({ json: { id: "stale-local-task", projectId: "remote-project", provider: "claude", model: "test" } }).catch(() => {});
  assert.equal(await page.evaluate(() => window.oldRead), "AbortError");
  await page.evaluate(() => window.oldCreate);
  assert.deepEqual(await page.evaluate(async () => {
    const { useApp } = await import("/web/src/lib/store.ts");
    return { stale: !!useApp.getState().threads["stale-local-task"], creating: useApp.getState().creatingThread };
  }), { stale: false, creating: false });
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("citropy.offline")).task[0].text), "LOCAL MESSAGE");
  await page.waitForFunction(() => localStorage.getItem("citropy.environment.ssh-test.citropy.offline") === "{}");
  assert.equal(await page.locator("textarea").inputValue(), "");
  assert.ok(!messages.some(event => event.remote && event.t === "thread.send" && event.text === "LOCAL MESSAGE"));
  assert.equal(await page.getByText("LOCAL RESPONSE", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "Git actions", exact: true }).waitFor();
  await page.getByRole("button", { name: "Choose workspace, Remote project", exact: true }).click();
  const workspaceMenu = page.locator(".workspace-menu");
  assert.equal(await workspaceMenu.getByRole("menuitem", { name: /^Local project/ }).count(), 1);
  assert.equal(await workspaceMenu.getByRole("menuitem", { name: /^Remote project/ }).count(), 1);
  await workspaceMenu.getByRole("menuitem", { name: "Local This computer", exact: true }).click();
  assert.equal(await workspaceMenu.getByRole("menuitem", { name: /^Local project/ }).count(), 0);
  await workspaceMenu.getByRole("textbox").fill("Local project");
  assert.equal(await workspaceMenu.getByRole("menuitem", { name: /^Local project/ }).count(), 1);
  await workspaceMenu.getByRole("textbox").fill("");
  await workspaceMenu.getByRole("menuitem", { name: "Local This computer", exact: true }).click();
  for (const width of [1440, 620]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForFunction(width => {
      const box = document.querySelector(".workspace-menu").getBoundingClientRect();
      return box.x >= 0 && box.right <= width + 1 && box.y >= 0 && box.bottom <= 900;
    }, width);
    await page.screenshot({ path: `/tmp/citropy-grouped-workspaces-${width}.png`, animations: "disabled" });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await workspaceMenu.getByRole("menuitem", { name: /Open another folder/ }).nth(1).click();
  await page.waitForFunction(() => window.folderChoices.length === 1);
  assert.deepEqual(await page.evaluate(() => window.folderChoices), ["ssh-test"]);
  assert.equal(await page.getByRole("dialog", { name: "Open remote folder", exact: true }).count(), 0);
  await page.waitForTimeout(150);
  assert.ok(messages.some(event => event.remote && event.t === "project.choose" && event.path === "/home/dev/projects"));
  await page.evaluate(() => window.citropyDesktop.disconnectEnvironment("ssh-test"));
  await page.getByRole("button", { name: "Reconnect", exact: true }).waitFor();
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await page.locator(".remote-connection-banner").waitFor({ state: "detached" });
  await page.waitForFunction(async () => (await import("/web/src/lib/environment.ts")).environmentName() === "Build server (applied)");
  await page.evaluate(() => window.citropyDesktop.disconnectEnvironment("ssh-test"));
  await page.getByRole("button", { name: "Switch to Local", exact: true }).click();
  await page.getByText("LOCAL RESPONSE", { exact: true }).waitFor();
  assert.equal(await page.locator("textarea").inputValue(), "LOCAL DRAFT");
  assert.deepEqual(await page.evaluate(async () => (await import("/web/src/lib/store.ts")).useApp.getState().projectDefaults), defaults);
  await page.evaluate(() => { window.nextFolder = null; });
  await page.getByRole("button", { name: "Choose workspace, Local project", exact: true }).click();
  await workspaceMenu.getByRole("menuitem", { name: /Open another folder/ }).nth(1).click();
  await page.waitForFunction(() => window.folderChoices.length === 2);
  assert.equal(await page.getByText("LOCAL RESPONSE", { exact: true }).count(), 1);
  for (let attempt = 0; attempt < 8; attempt++) {
    await page.getByRole("button", { name: "Choose workspace, Local project", exact: true }).click();
    await workspaceMenu.getByRole("menuitem", { name: /^Remote project/ }).click();
    await page.getByText("REMOTE RESPONSE", { exact: true }).waitFor();
    await page.locator("textarea").fill("REMOTE DRAFT");
    await page.getByRole("button", { name: "Choose workspace, Remote project", exact: true }).click();
    await workspaceMenu.getByRole("menuitem", { name: /^Local project/ }).click();
    await page.getByText("LOCAL RESPONSE", { exact: true }).waitFor();
    assert.equal(await page.locator("textarea").inputValue(), "LOCAL DRAFT");
  }
  await page.getByRole("button", { name: "Choose workspace, Local project", exact: true }).click();
  await workspaceMenu.getByRole("menuitem", { name: /^Remote project/ }).click();
  await page.getByText("REMOTE RESPONSE", { exact: true }).waitFor();
  await page.evaluate(async () => {
    window.nextFolder = "/home/dev/Clone destination";
    const { github } = await import("/web/src/lib/actions.ts");
    await github("clone", { repo: "owner/repo" });
    window.nextFolder = null;
    await github("clone", { repo: "owner/cancelled" });
  });
  const clones = messages.filter(event => event.t === "github.request" && event.request.operation === "clone");
  assert.equal(clones.length, 1);
  assert.equal(clones[0].remote, true);
  assert.equal(clones[0].request.parent, "/home/dev/Clone destination");
  const terminalRequested = Promise.withResolvers();
  await page.route(/@xterm_xterm.*\.js/, route => { terminalRequested.resolve(route); });
  await page.evaluate(async () => {
    const { useApp } = await import("/web/src/lib/store.ts");
    useApp.setState({ inspectorOpen: true, panels: [{ id: "remote-terminal", projectId: "remote-project", kind: "terminal", title: "Terminal" }], activePanels: { "remote-project": "remote-terminal" } });
  });
  const terminalModule = await terminalRequested.promise;
  await page.getByRole("button", { name: "Choose workspace, Remote project", exact: true }).click();
  await workspaceMenu.getByRole("menuitem", { name: /^Local project/ }).click();
  await page.getByText("LOCAL RESPONSE", { exact: true }).waitFor();
  const moduleResponse = await terminalModule.fetch();
  await terminalModule.fulfill({ response: moduleResponse, body: `${await moduleResponse.text()}\nwindow.delayedTerminalLoaded = true;` });
  await page.waitForFunction(() => window.delayedTerminalLoaded);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.ok(!messages.some(event => event.t === "term.open" && event.termId === "remote-terminal"));
  await page.evaluate(() => { window.nextFolder = { browse: true, path: "" }; });
  for (const choose of [false, true]) {
    await page.getByRole("button", { name: /^Choose workspace, / }).click();
    await workspaceMenu.getByRole("menuitem", { name: /Open another folder/ }).nth(1).click();
    const folders = page.getByRole("dialog", { name: /^Choose a folder on Build server/ });
    await folders.getByRole("listitem").filter({ hasText: "projects" }).waitFor();
    assert.equal(await folders.getByRole("listitem").filter({ hasText: ".cache" }).count(), 0);
    if (!choose) { await folders.getByRole("button", { name: "Cancel", exact: true }).click(); await folders.waitFor({ state: "detached" }); continue; }
    await page.screenshot({ path: "/tmp/citropy-remote-folder-home.png", animations: "disabled" });
    await folders.getByLabel("Hidden").check();
    await folders.getByRole("listitem").filter({ hasText: ".cache" }).waitFor();
    await folders.getByRole("listitem").filter({ hasText: "projects" }).click();
    await page.waitForFunction(() => document.querySelector(".remote-folder-path input").value === "/home/dev/projects");
    await folders.getByLabel("Folder path").fill("/missing");
    await folders.getByLabel("Folder path").press("Enter");
    assert.equal(await folders.getByRole("alert").textContent(), "That folder does not exist on the SSH host or cannot be opened.");
    await folders.getByRole("button", { name: "Open this folder", exact: true }).click();
    await folders.getByRole("alert").waitFor();
    assert.ok(await folders.isVisible());
    await folders.getByRole("button", { name: "Parent folder", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".remote-folder-path input").value === "/home/dev");
    assert.equal(await folders.getByRole("alert").count(), 0);
    await folders.getByRole("listitem").filter({ hasText: "projects" }).click();
    await folders.getByRole("listitem").filter({ hasText: "app" }).click();
    await folders.getByText("No folders here").waitFor();
    for (const width of [1440, 620]) {
      await page.setViewportSize({ width, height: 900 });
      const box = await folders.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 900);
      await page.screenshot({ path: `/tmp/citropy-remote-folder-${width}.png`, animations: "disabled" });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await folders.getByRole("button", { name: "Open this folder", exact: true }).click();
    await folders.waitFor({ state: "detached" });
  }
  await page.waitForFunction(() => window.folderListings.some(([, path]) => path === "/home/dev/projects/app"));
  assert.deepEqual([...new Set(await page.evaluate(() => window.folderListings.map(([id]) => id)))], ["ssh-test"]);
  await page.waitForTimeout(150);
  assert.ok(messages.some(event => event.remote && event.t === "project.choose" && event.path === "/home/dev/projects/app"));
  assert.equal(messages.filter(event => event.t === "project.choose" && event.path?.startsWith("/home/dev/projects/app")).length, 1);
  for (const [path, enter] of [["/home/dev/projects", false], ["/home/dev/projects/app", true], ["/home/dev/projects/app ", false]]) {
    await page.getByRole("button", { name: /^Choose workspace, / }).click();
    await workspaceMenu.getByRole("menuitem", { name: /Open another folder/ }).nth(1).click();
    const folders = page.getByRole("dialog", { name: /^Choose a folder on Build server/ });
    await folders.getByRole("listitem").filter({ hasText: "projects" }).waitFor();
    const before = messages.filter(event => event.t === "project.choose").length;
    await folders.getByLabel("Folder path").fill(path);
    if (enter) await folders.getByLabel("Folder path").press("Enter");
    else await folders.getByRole("button", { name: "Open this folder", exact: true }).click();
    await folders.waitFor({ state: "detached" });
    assert.equal(messages.filter(event => event.t === "project.choose").length, before + 1);
    assert.equal(messages.findLast(event => event.t === "project.choose").path, path);
  }
  await page.evaluate(() => {
    const list = window.citropyDesktop.listWorkspaceFolder;
    window.citropyDesktop.listWorkspaceFolder = (id, path) => path === "/home/dev/delayed"
      ? new Promise(resolve => { window.finishDelayedFolder = () => resolve({ path, parent: "/home/dev", folders: [] }); })
      : list(id, path);
  });
  const beforeCancel = messages.filter(event => event.t === "project.choose").length;
  await page.getByRole("button", { name: /^Choose workspace, / }).click();
  await workspaceMenu.getByRole("menuitem", { name: /Open another folder/ }).nth(1).click();
  const pendingFolders = page.getByRole("dialog", { name: /^Choose a folder on Build server/ });
  await pendingFolders.getByRole("listitem").filter({ hasText: "projects" }).waitFor();
  await pendingFolders.getByLabel("Folder path").fill("/home/dev/delayed");
  await pendingFolders.getByRole("button", { name: "Open this folder", exact: true }).click();
  await page.waitForFunction(() => window.finishDelayedFolder);
  await pendingFolders.getByRole("button", { name: "Cancel", exact: true }).click();
  await pendingFolders.waitFor({ state: "detached" });
  await page.getByRole("button", { name: /^Choose workspace, / }).click();
  await workspaceMenu.getByRole("menuitem", { name: /Open another folder/ }).nth(1).click();
  await pendingFolders.getByRole("listitem").filter({ hasText: "projects" }).waitFor();
  await page.evaluate(() => window.finishDelayedFolder());
  assert.equal(await pendingFolders.getByLabel("Folder path").inputValue(), "/home/dev");
  await pendingFolders.getByRole("button", { name: "Cancel", exact: true }).click();
  await pendingFolders.waitFor({ state: "detached" });
  assert.equal(messages.filter(event => event.t === "project.choose").length, beforeCancel);
  assert.equal(navigations, 1);
  assert.equal(await page.evaluate(() => window.environmentListenerCount()), 1);
  assert.deepEqual(errors, []);
});
