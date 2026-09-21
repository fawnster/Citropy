import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

const hash = "c".repeat(40);
const files = [
  { path: "src/changed.ts", index: " ", work: "M", added: 3, removed: 1, staged: false, untracked: false },
  { path: "src/staged.ts", index: "M", work: " ", added: 2, removed: 0, staged: true, untracked: false },
];
const overview = {
  repository: true,
  hasCommits: true,
  mergeInProgress: false,
  status: { branch: "main", upstream: "origin/main", ahead: 2, behind: 1, clean: false, files },
  branches: [
    { name: "main", current: true, remote: false, upstream: "origin/main", subject: "Set up the workspace", date: "2026-09-12T10:00:00Z" },
    { name: "feature/sections", current: false, remote: false, upstream: "", subject: "Split the git panel", date: "2026-09-13T10:00:00Z" },
    { name: "origin/main", current: false, remote: true, upstream: "", subject: "Set up the workspace", date: "2026-09-12T10:00:00Z" },
  ],
  commits: [{ hash, author: "Citropy", date: "2026-09-12T10:00:00Z", subject: "Set up the workspace", refs: "HEAD -> main" }],
  remotes: [{ name: "origin", url: "https://github.com/tinuxongit/Citropy.git" }],
  stashes: [{ ref: "stash@{0}", subject: "WIP on main: saved work" }],
};

test("every Git section renders from the panel", { timeout: 120_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-git-sections-"));
  const server = await createServer({
    configFile: false,
    cacheDir: join(directory, "cache"),
    root: fileURLToPath(new URL("..", import.meta.url)),
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, watch: null },
  });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function panel(test) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", entry => { if (entry.type() === "error" && /same key|unique.*key/.test(entry.text())) errors.push(entry.text()); });
    test.after(async () => { await page.close(); assert.deepEqual(errors, []); });
    await page.addInitScript(() => {
      for (const [key, value] of Object.entries({ project: "workspace", theme: "dark", inspector: "0", compactNavigation: "1" })) localStorage.setItem(`citropy.${key}`, value);
    });
    await page.routeWebSocket("**/socket", socket => {
      socket.onMessage(raw => {
        const event = JSON.parse(raw);
        if (event.t === "git.manage")
          socket.send(JSON.stringify({
            t: "git.manage",
            requestId: event.requestId,
            result: event.operation === "show"
              ? { kind: "detail", message: "Set up the workspace", patches: [{ path: "src/changed.ts", added: 1, removed: 0, hunks: [{ header: "", oldStart: 1, newStart: 1, lines: [{ type: "add", newNo: 1, text: "export const ready = true;" }] }] }] }
              : overview,
          }));
        if (event.t === "git.refresh") socket.send(JSON.stringify({ t: "git.status", projectId: "workspace", status: overview.status }));
        if (event.t === "git.diff") socket.send(JSON.stringify({ t: "git.diff", requestId: event.requestId, patch: { path: event.path, added: 1, removed: 0, hunks: [{ header: "", oldStart: 1, newStart: 1, lines: [{ type: "add", newNo: 1, text: "export const ready = true;" }] }] } }));
      });
      socket.send(JSON.stringify({
        t: "hello",
        snapshot: { projects: [{ id: "workspace", name: "Sections workspace", path: "/example", isGit: true, lastOpened: 1 }], threads: [], providers: [], permissions: [], home: "/example", panels: [] },
      }));
    });
    await page.goto(server.resolvedUrls.local[0]);
    await page.getByRole("button", { name: "Source control", exact: true }).click();
    page.section = name => page.locator(".section-link").filter({ has: page.getByText(name, { exact: true }) });
    return page;
  }

  await t.test("Changes lists staged and unstaged work", async (test) => {
    const page = await panel(test);
    await page.locator(".git-file-group").first().waitFor();
    assert.equal(await page.locator(".git-file-group").count(), 2);
    await page.getByRole("button", { name: /src\/changed\.ts/ }).first().waitFor();
    await page.getByRole("button", { name: /src\/staged\.ts/ }).first().waitFor();
  });

  await t.test("History lists commits and opens one", async (test) => {
    const page = await panel(test);
    await page.section("History").click();
    await page.locator(".git-history-row").first().waitFor();
    await page.getByText("Set up the workspace", { exact: true }).first().click();
    await page.locator(".git-review-pane").waitFor();
  });

  await t.test("Branches lists local and remote branches and filters them", async (test) => {
    const page = await panel(test);
    await page.section("Branches").click();
    await page.locator(".git-branch-row").first().waitFor();
    const rows = page.locator(".git-branch-row");
    assert.ok(await rows.count() >= 3, "local and remote branches should both render");
    await page.getByRole("textbox", { name: "Filter branches" }).fill("feature");
    await page.getByText("feature/sections", { exact: true }).first().waitFor();
    assert.equal(await rows.count(), 1, "the filter should narrow the branch list");
  });

  await t.test("Stashes lists saved work and previews it", async (test) => {
    const page = await panel(test);
    await page.section("Stashes").click();
    await page.locator(".git-history-row").first().waitFor();
    await page.getByText("WIP on main: saved work", { exact: true }).first().click();
    await page.locator(".git-review-pane").waitFor();
    await page.getByRole("button", { name: "Delete stash", exact: true }).first().waitFor();
  });

  await t.test("Remotes lists connected repositories", async (test) => {
    const page = await panel(test);
    await page.section("Remotes").click();
    await page.locator(".git-remote-row").first().waitFor();
    await page.getByText("origin", { exact: true }).first().waitFor();
    await page.getByText("https://github.com/tinuxongit/Citropy.git", { exact: true }).first().waitFor();
  });
});
