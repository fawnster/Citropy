import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("Git refresh keeps conversation branches synchronized with their actual worktree", { timeout: 60000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "citropy-workspace-branches-"));
  const previousData = process.env.CITROPY_DATA_DIR;
  process.env.CITROPY_DATA_DIR = join(directory, "data");
  let store, journal, unsubscribe;
  t.after(() => {
    unsubscribe?.();
    store?.flush();
    journal?.close();
    if (previousData === undefined) delete process.env.CITROPY_DATA_DIR;
    else process.env.CITROPY_DATA_DIR = previousData;
    rmSync(directory, { recursive: true, force: true });
  });
  ({ store } = await import("../server/store.ts"));
  const { bus } = await import("../server/bus.ts");
  ({ eventJournal: journal } = await import("../server/event-journal.ts"));
  const { refreshGit, forgetGit } = await import("../server/git-monitor.ts");
  const events = [];
  unsubscribe = bus.subscribe(event => events.push(event));
  const git = (cwd, ...args) => execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(directory, "no-global-config") },
  }).trim();
  const repository = name => {
    const path = join(directory, name);
    mkdirSync(path);
    git(path, "init", "-b", "main");
    git(path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Initial");
    return store.openProject(path);
  };
  const project = repository("project");
  const otherProject = repository("other-project");
  const worktree = join(directory, "isolated-worktree");
  git(project.path, "worktree", "add", "-b", "feature/isolated", worktree);
  const create = (title, options = {}) => store.createThread({
    projectId: project.id, provider: "claude", title, permissionMode: "manual",
    workspacePath: project.path, workspaceBranch: "main", ...options,
  });
  const selected = create("Selected");
  const sibling = create("Inactive", { pinned: true });
  const legacy = create("Legacy", { workspacePath: undefined });
  const child = create("Subagent", { parentThreadId: selected.id });
  const isolated = create("Isolated", { workspacePath: worktree, workspaceBranch: "feature/isolated" });
  const foreign = create("Other project", { projectId: otherProject.id, workspacePath: otherProject.path });
  const shared = [selected, sibling, legacy, child];
  const before = new Map([...shared, isolated, foreign].map(thread => [thread.id, {
    updatedAt: thread.updatedAt, createdAt: thread.createdAt, running: thread.running,
    status: thread.status, runCount: thread.runCount, messages: thread.messages,
  }]));
  t.after(() => { forgetGit(project.id); forgetGit(otherProject.id); });

  await t.test("project refresh updates every conversation sharing a checkout, not other worktrees or projects", async () => {
    await refreshGit(project.id, true);
    git(project.path, "switch", "-c", "release-prep/0.4.2");
    events.length = 0;
    await refreshGit(project.id, true);
    assert.equal(project.branch, "release-prep/0.4.2");
    assert.ok(shared.every(thread => thread.workspaceBranch === "release-prep/0.4.2"),
      "a live Git status must replace the branch saved when each conversation was created");
    assert.equal(isolated.workspaceBranch, "feature/isolated");
    assert.equal(foreign.workspaceBranch, "main");
    assert.deepEqual(new Set(events.filter(event => event.t === "thread.upsert").map(event => event.thread.id)),
      new Set(shared.map(thread => thread.id)));
  });

  await t.test("thread-scoped refresh updates inactive siblings and subagents without changing activity", async () => {
    git(project.path, "switch", "-c", "fix/thread-refresh");
    await refreshGit(project.id, true, selected.id);
    assert.ok(shared.every(thread => thread.workspaceBranch === "fix/thread-refresh"));
    for (const thread of [...shared, isolated, foreign]) {
      const previous = before.get(thread.id);
      for (const key of Object.keys(previous)) assert.equal(thread[key], previous[key], `${thread.title}: ${key}`);
    }
  });

  await t.test("unchanged Git status repairs newly loaded stale metadata without duplicate events", async () => {
    git(project.path, "switch", "main");
    await refreshGit(project.id);
    const stale = create("Restored stale metadata", { workspaceBranch: "old/saved-branch" });
    const updatedAt = stale.updatedAt;
    events.length = 0;
    await refreshGit(project.id);
    assert.equal(stale.workspaceBranch, "main");
    assert.equal(stale.updatedAt, updatedAt);
    assert.deepEqual(events.filter(event => event.t === "thread.upsert").map(event => event.thread.id), [stale.id]);
    assert.equal(events.filter(event => event.t === "git.status").length, 0, "status deduplication still applies");
    events.length = 0;
    await refreshGit(project.id);
    assert.equal(events.length, 0, "unchanged branches must not generate repeated metadata writes or events");
  });

  await t.test("renaming an isolated worktree branch updates only that worktree", async () => {
    const coIsolated = create("Same isolated checkout", { workspacePath: worktree, workspaceBranch: "feature/isolated" });
    git(worktree, "branch", "-m", "feature/renamed");
    await refreshGit(project.id, true, isolated.id);
    assert.equal(isolated.workspaceBranch, "feature/renamed");
    assert.equal(coIsolated.workspaceBranch, "feature/renamed");
    assert.ok(shared.every(thread => thread.workspaceBranch === "main"));
    assert.equal(project.branch, "main");
    assert.equal(foreign.workspaceBranch, "main");
  });

  await t.test("detached HEAD replaces the old named branch", async () => {
    git(worktree, "checkout", "--detach", "HEAD");
    events.length = 0;
    await refreshGit(project.id, true, isolated.id);
    const status = events.findLast(event => event.t === "git.status").status;
    assert.equal(status.branch, "detached");
    assert.equal(isolated.workspaceBranch, status.branch);
    assert.equal(project.branch, "main");
  });

  await t.test("corrected branch metadata survives a save and process restart", async () => {
    git(project.path, "switch", "release-prep/0.4.2");
    await refreshGit(project.id, true, selected.id);
    store.flush();
    const saved = JSON.parse(readFileSync(join(process.env.CITROPY_DATA_DIR, "threads", `${selected.id}.json`), "utf8"));
    assert.equal(saved.workspaceBranch, "release-prep/0.4.2");
    const module = new URL("../server/store.ts", import.meta.url).href;
    const restored = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
      `const {store}=await import(${JSON.stringify(module)}); process.stdout.write(JSON.stringify(store.threads.get(${JSON.stringify(selected.id)}).workspaceBranch));`],
      { encoding: "utf8", env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(JSON.parse(restored), "release-prep/0.4.2");
  });
});
