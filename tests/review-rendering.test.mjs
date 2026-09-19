import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

const hash = "a".repeat(40);
const smallHash = "b".repeat(40);
const smallReview = { kind: "detail", message: "Small change", patches: [{ path: "small.ts", added: 1, removed: 0, hunks: [{ header: "", oldStart: 1, newStart: 1, lines: [{ type: "add", newNo: 1, text: "export const settled = true;" }] }] }] };
const patches = Array.from({ length: 120 }, (_, file) => ({
  path: `src/module-${file}.ts`, added: 400, removed: 0,
  hunks: [{ header: "", oldStart: 1, newStart: 1, lines: Array.from({ length: 400 }, (_, line) => ({ type: "add", newNo: line + 1, text: `export const item${line} = { file: ${file}, value: "Example ${line}" };` })) }],
}));
const overview = {
  repository: true, hasCommits: true, mergeInProgress: false,
  status: { branch: "main", ahead: 0, behind: 0, files: [] },
  branches: [{ name: "main", current: true, remote: false, upstream: "origin/main" }],
  commits: [
    { hash, author: "Citropy", date: "2026-09-12T10:00:00Z", subject: "Large change", refs: "HEAD -> main" },
    { hash: smallHash, author: "Citropy", date: "2026-09-11T10:00:00Z", subject: "Small change", refs: "" },
  ],
  remotes: [], stashes: [],
};

test("reviews and source previews keep rendering bounded", { timeout: 120_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-review-"));
  const server = await createServer({ configFile: false, cacheDir: join(directory, "cache"), root: fileURLToPath(new URL("..", import.meta.url)), plugins: [react()], logLevel: "error", server: { host: "127.0.0.1", port: 0, watch: null } });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await rm(directory, { recursive: true, force: true }); });
  async function fixture(test, { files = [], panels = [] } = {}) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(20000);
    const errors = [];
    const requests = [];
    const state = structuredClone(overview);
    state.status.files = files;
    let connection;
    let failCommit = false;
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", entry => { if (entry.type() === "error" && /same key|unique.*key/.test(entry.text())) errors.push(entry.text()); });
    test.after(async () => { await page.close(); assert.deepEqual(errors, []); });
    await page.addInitScript(() => {
      for (const [key, value] of Object.entries({ project: "workspace", theme: "dark", uiScale: "120", inspector: "0", compactNavigation: "1" })) localStorage.setItem(`citropy.${key}`, value);
      window.reviewTasks = [];
      new PerformanceObserver(list => window.reviewTasks.push(...list.getEntries().map(entry => entry.duration))).observe({ type: "longtask", buffered: true });
    });
    await page.routeWebSocket("**/socket", socket => {
      connection = socket;
      socket.onMessage(raw => {
        const event = JSON.parse(raw);
        requests.push(event);
        if (event.t === "github.request") socket.send(JSON.stringify({ t: "github.result", requestId: event.requestId, result: { installed: true, repositories: [] } }));
        if (event.t === "git.manage") {
          const result = event.operation === "show"
            ? event.value === smallHash ? smallReview : { kind: "detail", message: "Large change\n\nReview many files without mounting them all.", patches }
            : event.operation === "commit" ? "Created commit." : state;
          socket.send(JSON.stringify({ t: "git.manage", requestId: event.requestId, ...(event.operation === "commit" && failCommit ? { error: "Commit hook rejected the message" } : { result }) }));
        }
        if (event.t === "git.refresh") socket.send(JSON.stringify({ t: "git.status", projectId: "workspace", status: state.status }));
        if (event.t === "git.diff") socket.send(JSON.stringify({ t: "git.diff", requestId: event.requestId, patch: patches.find(patch => patch.path === event.path) ?? { ...patches[0], path: event.path } }));
        if (event.t === "file.tree") socket.send(JSON.stringify({ t: "file.tree", requestId: event.requestId, entries: ["large.ts", "small.ts"].map(path => ({ path, name: path, dir: false })) }));
      });
      socket.send(JSON.stringify({ t: "hello", snapshot: { projects: [{ id: "workspace", name: "Review workspace", path: "/example", isGit: true, lastOpened: 1 }], threads: [], providers: [], permissions: [], home: "/example", panels } }));
    });
    await page.goto(server.resolvedUrls.local[0]);
    await page.getByRole("button", { name: "Source control", exact: true }).waitFor();
    return { page, requests, state, failCommit: value => { failCommit = value; }, emit: event => connection.send(JSON.stringify(event)) };
  }

  await t.test("large commits mount visible files and lines while preserving expansion", async (test) => {
    const { page } = await fixture(test);
    await page.getByRole("button", { name: "Source control", exact: true }).click();
    await page.getByRole("button", { name: "History", exact: true }).click();
    await page.locator(".diff-code span[style]").first().waitFor({ timeout: 30_000 });
    const metrics = await page.evaluate(() => ({ lines: document.querySelectorAll(".diff-line").length, elements: document.querySelectorAll(".git-patches *").length, longestTask: Math.max(0, ...window.reviewTasks) }));
    test.diagnostic(JSON.stringify(metrics));
    assert.ok(metrics.lines < 150, `Only visible diff lines should be mounted: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.elements < 2500, `The review DOM should remain bounded: ${JSON.stringify(metrics)}`);
    await page.screenshot({ path: "/tmp/citropy-review-desktop.png", animations: "disabled" });
    const first = page.locator(".git-patch").filter({ has: page.getByRole("button", { name: /^src\/module-0.ts / }) });
    await first.getByRole("button", { name: "Show 240 more lines" }).click();
    await first.getByRole("region").evaluate(node => { node.scrollTop = node.scrollHeight; });
    await first.getByText('export const item399 = { file: 0, value: "Example 399" };', { exact: true }).waitFor();
    assert.ok(await first.locator(".diff-line").count() < 40);
    await first.locator(".git-patch-heading").click();
    assert.equal(await first.locator(".diff-line").count(), 0);
    await page.locator(".git-review-scroll").evaluate(node => { node.scrollTop = node.scrollHeight; });
    await page.getByRole("button", { name: /^src\/module-119.ts / }).waitFor();
    assert.equal(await first.count(), 0);
    await page.locator(".git-review-scroll").evaluate(node => { node.scrollTop = 0; });
    await first.locator('.git-patch-heading[aria-expanded="false"]').waitFor();
    await first.locator(".git-patch-heading").click();
    assert.equal(await first.getByRole("button", { name: "Show 240 more lines" }).count(), 0);
    for (const width of [1440, 960]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.screenshot({ path: `/tmp/citropy-review-${width}.png`, animations: "disabled" });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator(".git-history-row").filter({ hasText: "Small change" }).click();
    await page.getByText("export const settled = true;", { exact: true }).waitFor();
    assert.equal(await page.locator(".git-patch").count(), 1);
    assert.equal(await page.locator(".diff-line").count(), 1);
    assert.equal(await page.locator(".git-review-scroll").evaluate(node => node.scrollTop), 0);
    assert.equal(await page.getByText(/Example 399/).count(), 0);
  });

  await t.test("files are grouped by change type and single-file previews fill the resized window", async (test) => {
    const files = [
      { path: "src/modified.ts", index: " ", work: "M", staged: false, untracked: false },
      { path: "src/deleted.ts", index: " ", work: "D", staged: false, untracked: false },
      { path: "src/added.ts", index: "?", work: "?", staged: false, untracked: true },
      { path: "src/mixed.ts", index: "A", work: "M", staged: true, untracked: false },
      { path: "src/removed.ts", index: "D", work: " ", staged: true, untracked: false },
      { path: "src/staged.ts", index: "M", work: " ", staged: true, untracked: false },
    ].map(file => ({ ...file, added: 400, removed: 0 }));
    const { page, requests } = await fixture(test, { files });
    await page.getByRole("button", { name: "Source control", exact: true }).click();
    await page.locator(".git-single-patch .diff-line").first().waitFor();
    const groups = page.locator(".git-file-group");
    assert.deepEqual(await groups.nth(0).locator(".change-category").allTextContents(), ["Added1", "Deleted1", "Changed2"]);
    assert.deepEqual(await groups.nth(1).locator(".change-category").allTextContents(), ["Added1", "Deleted1", "Changed1"]);
    assert.deepEqual(await groups.nth(0).locator(".git-file-label strong").allTextContents(), ["added.ts", "deleted.ts", "mixed.ts", "modified.ts"]);
    assert.equal(requests.findLast(event => event.t === "git.diff").path, "src/added.ts");
    for (const index of [0, 1]) {
      await groups.nth(index).locator(".git-file-name").filter({ hasText: "mixed.ts" }).click();
      await page.waitForFunction(() => Boolean(document.querySelector(".git-single-patch .diff-line")));
      assert.equal(requests.findLast(event => event.t === "git.diff").staged, Boolean(index));
    }
    let previousHeight = 0;
    for (const size of [{ width: 1440, height: 860 }, { width: 1920, height: 1200 }]) {
      await page.setViewportSize(size);
      await page.waitForFunction(() => {
        const parent = document.querySelector(".git-single-patch").getBoundingClientRect();
        const diff = document.querySelector(".git-single-patch .diff").getBoundingClientRect();
        return parent.bottom - diff.bottom < 28;
      });
      const metrics = await page.locator(".git-single-patch .diff-body").evaluate(node => ({ height: node.clientHeight, total: node.scrollHeight, lines: node.querySelectorAll(".diff-line").length }));
      assert.ok(metrics.height > previousHeight);
      assert.ok(metrics.total > metrics.height);
      assert.ok(metrics.lines < 75);
      previousHeight = metrics.height;
    }
    await page.screenshot({ path: "/tmp/citropy-grouped-diff-desktop.png", animations: "disabled" });
    await page.locator(".git-single-patch .diff-body").evaluate(node => { node.scrollTop = node.scrollHeight; });
    await page.getByText('export const item399 = { file: 0, value: "Example 399" };', { exact: true }).waitFor();
    await page.setViewportSize({ width: 960, height: 900 });
    await page.screenshot({ path: "/tmp/citropy-grouped-diff-narrow.png", animations: "disabled" });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  });

  await t.test("commit fields keep title and description separate and survive a failed commit", async (test) => {
    const { page, requests, failCommit } = await fixture(test, { files: [{ path: "src/module-0.ts", index: "M", work: " ", staged: true, untracked: false, added: 400, removed: 0 }] });
    await page.getByRole("button", { name: "Source control", exact: true }).click();
    const title = page.getByRole("textbox", { name: "Commit title", exact: true });
    const description = page.getByRole("textbox", { name: "Description Optional", exact: true });
    const commit = page.getByRole("button", { name: "Commit staged changes", exact: true });
    await description.fill("A description cannot replace the title.");
    assert.equal(await commit.isDisabled(), true);
    await title.fill("Speed up commit reviews");
    await description.fill("Render visible files and lines.\nKeep syntax coloring off the UI thread.");
    for (const width of [1440, 960]) {
      await page.setViewportSize({ width, height: 1000 });
      if (width === 960) await page.getByRole("button", { name: "Back to changed files", exact: true }).click();
      await page.screenshot({ path: `/tmp/citropy-commit-fields-${width}.png`, animations: "disabled" });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    failCommit(true);
    await commit.click();
    await page.getByText("Commit hook rejected the message", { exact: true }).first().waitFor();
    assert.equal(await title.inputValue(), "Speed up commit reviews");
    assert.equal(await description.inputValue(), "Render visible files and lines.\nKeep syntax coloring off the UI thread.");
    failCommit(false);
    await commit.click();
    await page.waitForFunction(() => document.getElementById("git-commit-message").value === "");
    assert.equal(requests.findLast(event => event.operation === "commit").value, "Speed up commit reviews\n\nRender visible files and lines.\nKeep syntax coloring off the UI thread.");
    assert.equal(await description.inputValue(), "");
    await title.fill("Title alone");
    await commit.click();
    await page.waitForFunction(() => document.getElementById("git-commit-message").value === "");
    assert.equal(requests.findLast(event => event.operation === "commit").value, "Title alone");
    assert.equal(requests.filter(event => ["stage", "stageAll"].includes(event.operation) || event.t === "git.commit").length, 0);
  });

  await t.test("source previews virtualize long files and theme changes reuse the fetched text", async (test) => {
    const { page } = await fixture(test, { panels: [{ id: "files", projectId: "workspace", kind: "files", title: "Files" }] });
    const source = Array.from({ length: 5000 }, (_, index) => `export const value${index} = ${index};`).join("\n");
    let fetches = 0;
    await page.route("**/api/preview?**", route => {
      fetches++;
      const path = new URL(route.request().url()).searchParams.get("path");
      const text = path === "large.ts" ? source : "export const current = true;";
      return route.fulfill({ json: { path, name: path, mime: "text/plain", size: text.length, text } });
    });
    await page.evaluate(async () => (await import("/web/src/lib/store.ts")).useApp.setState({ inspectorOpen: true }));
    await page.getByRole("button", { name: "large.ts", exact: true }).click();
    await page.locator(".source-line code span[style]").first().waitFor();
    assert.ok(await page.locator(".source-line").count() < 70);
    await page.getByRole("region", { name: "Source of large.ts" }).evaluate(node => { node.scrollTop = node.scrollHeight; });
    await page.getByText("export const value4999 = 4999;", { exact: true }).waitFor();
    const loadedFetches = fetches;
    const color = await page.locator('.source-line[data-index="4999"] code span[style]').first().getAttribute("style");
    await page.evaluate(async () => (await import("/web/src/lib/store.ts")).setTheme("light"));
    await page.waitForFunction(color => {
      const token = document.querySelector('.source-line[data-index="4999"] code span[style]');
      return token && token.getAttribute("style") !== color;
    }, color);
    assert.equal(fetches, loadedFetches);
    await page.screenshot({ path: "/tmp/citropy-source-light.png", animations: "disabled" });
    await page.getByRole("button", { name: "Close preview", exact: true }).click();
    await page.getByRole("button", { name: "small.ts", exact: true }).click();
    await page.getByText("export const current = true;", { exact: true }).waitFor();
    assert.equal(await page.locator(".source-line").count(), 1);
    assert.equal(await page.getByText(/value4999/).count(), 0);
    assert.ok(fetches > loadedFetches && fetches <= loadedFetches + 2);
    const markdown = await page.evaluate(async () => {
      const { renderMarkdown } = await import("/web/src/lib/markdown.ts");
      return Promise.all(["dark", "light"].map(async theme => {
        const html = await renderMarkdown("```ts\nexport const text = '<script>';\n```", theme);
        const document = new DOMParser().parseFromString(html, "text/html");
        return { html, text: document.querySelector("code").textContent, scripts: document.querySelectorAll("script").length };
      }));
    });
    assert.match(markdown[0].html, /shiki citropy-dark/);
    assert.match(markdown[1].html, /shiki citropy-light/);
    assert.ok(markdown.every(result => result.text === "export const text = '<script>';" && result.scripts === 0));
  });

  await t.test("the changes panel mounts only visible files and keeps expanded diffs on return", async (test) => {
    const files = Array.from({ length: 1000 }, (_, index) => ({ path: `src/module-${index}.ts`, index: " ", work: "M", staged: false, untracked: false, added: 400, removed: 0 }));
    const { page } = await fixture(test, { files, panels: [{ id: "changes", projectId: "workspace", kind: "changes", title: "Changes" }] });
    await page.evaluate(async () => (await import("/web/src/lib/store.ts")).useApp.setState({ inspectorOpen: true }));
    await page.locator(".change-head").first().waitFor();
    assert.ok(await page.locator(".change").count() < 40);
    const first = page.locator(".change").filter({ hasText: "module-0.ts" });
    await first.locator(".change-head").click();
    await first.getByRole("button", { name: "Show 360 more lines" }).click();
    await page.locator(".changes-list").evaluate(node => { node.scrollTop = node.scrollHeight; });
    await page.getByText("module-999.ts", { exact: true }).waitFor();
    assert.equal(await first.count(), 0);
    await page.locator(".changes-list").evaluate(node => { node.scrollTop = 0; });
    await first.locator(".diff-line").first().waitFor();
    assert.equal(await first.locator(".change-head").getAttribute("aria-expanded"), "true");
    assert.equal(await first.getByRole("button", { name: "Show 360 more lines" }).count(), 0);
    await first.locator(".change-head").click();
    await first.locator(".diff-line").first().waitFor({ state: "detached" });
    assert.ok(await page.locator(".change").count() < 40);
    await page.screenshot({ path: "/tmp/citropy-changes-panel.png", animations: "disabled" });
  });
});
