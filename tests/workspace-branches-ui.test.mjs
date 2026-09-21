import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

test("the sidebar and titlebar agree without borrowing another worktree's cached branch", { timeout: 120000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-branch-labels-ui-"));
  let server, browser;
  t.after(async () => { await browser?.close(); await server?.close(); await rm(directory, { recursive: true, force: true }); });
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), plugins: [react()], logLevel: "error", cacheDir: join(directory, "cache"), server: { host: "127.0.0.1", port: 0, watch: null } });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("citropy.project", "project");
    localStorage.setItem("citropy.thread", "selected");
    localStorage.setItem("citropy.uiScale", "100");
    localStorage.setItem("citropy.gitPanel", "0");
    localStorage.setItem("citropy.inspector", "0");
  });
  const project = { id: "project", path: "/project", name: "Project", isGit: true, branch: "main", lastOpened: 1 };
  const makeThread = (id, title, path, branch) => ({
    id, title, projectId: project.id, provider: "claude", model: "test", createdAt: 1, updatedAt: 1,
    running: false, status: "idle", permissionMode: "manual", workspacePath: path, workspaceBranch: branch,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, contextTokens: 0, contextMax: 200000, turns: 0 },
  });
  const selected = makeThread("selected", "Selected conversation", project.path, "main");
  const sibling = makeThread("sibling", "Shared checkout conversation", project.path, "main");
  const isolated = makeThread("isolated", "Isolated worktree conversation", "/worktrees/isolated", "feature/isolated");
  let connection;
  await page.route("**/api/**", route => route.fulfill({ json: {} }));
  await page.routeWebSocket("**/socket", socket => {
    connection = socket;
    socket.onMessage(message => {
      const request = JSON.parse(message.toString());
      if (request.t === "thread.load") socket.send(JSON.stringify({ t: "thread.messages", threadId: request.id, messages: [] }));
      // Hold Git refresh responses deliberately: switching must be correct even
      // while a previous checkout's project-level cache is still populated.
    });
    socket.send(JSON.stringify({ t: "hello", snapshot: {
      projects: [project], threads: [selected, sibling, isolated],
      providers: [{ id: "claude", label: "Claude Code", available: true, enabled: true, models: [{ id: "test", label: "Example model" }] }],
      permissions: [], home: "/home",
    } }));
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByRole("button", { name: selected.title, exact: true }).waitFor();
  const status = branch => ({ branch, ahead: 0, behind: 0, files: [], clean: true });
  const send = event => connection.send(JSON.stringify(event));
  const agrees = async (id, branch) => {
    await page.waitForFunction(({ id, branch }) => {
      const header = document.querySelector(".workspace-breadcrumb .branch .truncate")?.textContent;
      const row = document.querySelector(`.thread-entry[data-thread-id="${id}"] .thread-row-branch .truncate`)?.textContent;
      const active = document.querySelector(`.thread-entry[data-thread-id="${id}"] .thread-row[data-active="true"]`);
      return active && header === branch && row === branch;
    }, { id, branch });
  };

  await t.test("an old project cache cannot override the selected conversation's checkout", async () => {
    send({ t: "git.status", projectId: project.id, threadId: selected.id, status: status("release-prep/previous-worktree") });
    await page.waitForFunction(async () => {
      const { useApp } = await import("/web/src/lib/store.ts");
      return useApp.getState().git.project?.branch === "release-prep/previous-worktree";
    });
    await agrees(selected.id, "main");
  });

  await t.test("a real branch refresh updates both visible labels and shared-checkout siblings", async () => {
    selected.workspaceBranch = sibling.workspaceBranch = "release-prep/0.4.2";
    send({ t: "thread.upsert", thread: selected });
    send({ t: "thread.upsert", thread: sibling });
    send({ t: "project.upsert", project: { ...project, branch: selected.workspaceBranch } });
    send({ t: "git.status", projectId: project.id, threadId: selected.id, status: status(selected.workspaceBranch) });
    await agrees(selected.id, selected.workspaceBranch);
    assert.equal(await page.locator(`.thread-entry[data-thread-id="${sibling.id}"] .thread-row-branch .truncate`).textContent(), selected.workspaceBranch);
    assert.equal(await page.locator(`.thread-entry[data-thread-id="${isolated.id}"] .thread-row-branch .truncate`).textContent(), "feature/isolated");
  });

  await t.test("switching worktrees is correct before a fresh Git response arrives", async () => {
    await page.getByRole("button", { name: isolated.title, exact: true }).click();
    await agrees(isolated.id, "feature/isolated");
    send({ t: "git.status", projectId: project.id, threadId: selected.id, status: status("late/old-response") });
    await agrees(isolated.id, "feature/isolated");
    await page.getByRole("button", { name: selected.title, exact: true }).click();
    await agrees(selected.id, selected.workspaceBranch);
  });

  await t.test("an unknown branch does not fall back to another checkout's branch", async () => {
    await page.getByRole("button", { name: isolated.title, exact: true }).click();
    send({ t: "thread.upsert", thread: { ...isolated, workspaceBranch: undefined } });
    await page.waitForFunction(() =>
      !document.querySelector(".workspace-breadcrumb .branch") &&
      !document.querySelector('.thread-entry[data-thread-id="isolated"] .thread-row-branch'));
    send({ t: "thread.upsert", thread: { ...isolated, workspaceBranch: "detached" } });
    await agrees(isolated.id, "detached");
  });
  assert.deepEqual(errors, []);
});
