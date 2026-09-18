import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const root = await mkdtemp(join(tmpdir(), "citropy-automation-"));
process.env.CITROPY_DATA_DIR = join(root, "data");
const cwd = join(root, "project");
const git = (path, ...args) => execFileSync("git", args, { cwd: path, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" } });
await mkdir(join(cwd, "src"), { recursive: true });
git(cwd, "init");
await writeFile(join(cwd, "src", "file with spaces.ts"), "one\ntwo\nthree\n");
await writeFile(join(cwd, "AGENTS.md"), "Project instructions\n");
git(cwd, "add", ".");
git(cwd, "commit", "-m", "Initial");
const { store } = await import("../server/store.ts");
const { eventJournal } = await import("../server/event-journal.ts");
const { prepareContext, inspectContext, findContextPaths } = await import("../server/context.ts");
const { contextReference, contextReferences } = await import("../shared/context.ts");
const { copyToWorktree, removeWorktree } = await import("../server/worktree-actions.ts");
const terminals = await import("../server/terminals.ts");
const { openPanel, panelList } = await import("../server/panels.ts");
const project = store.openProject(cwd);
const thread = store.createThread({ projectId: project.id, provider: "opencode", title: "Automation", permissionMode: "manual" });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test("context excerpts preserve exact lines and ignore legacy rules without escaping the workspace", async () => {
  project.settings = { rules: [{ id: "types", name: "Types", patterns: ["src/**/*.ts"], text: "Use strict types." }, { id: "python", name: "Python", patterns: ["**/*.py"], text: "Use type hints." }] };
  const reference = contextReference("src/file with spaces.ts") + "#L2-L3";
  const result = await prepareContext(thread, `Check ${reference}`);
  assert.equal(result.sources[0].characters, 9);
  assert.match(result.prompt, /two\nthree/);
  assert.equal(result.sources.length, 1);
  assert.doesNotMatch(result.prompt, /Use strict types/);
  assert.doesNotMatch(result.prompt, /Use type hints/);
  assert.equal(contextReferences(contextReference("a]b.txt"))[0].path, "a]b.txt");
  assert.ok((await findContextPaths(thread, "spaces")).some(entry => entry.path === "src/file with spaces.ts"));
  assert.ok((await inspectContext(thread, reference)).instructions.includes(join(cwd, "AGENTS.md")));
  const config = join(root, "custom-config");
  const previousConfig = process.env.XDG_CONFIG_HOME;
  await mkdir(join(config, "opencode"), { recursive: true });
  await writeFile(join(config, "opencode", "AGENTS.md"), "Global instructions");
  try {
    process.env.XDG_CONFIG_HOME = config;
    assert.ok((await inspectContext(thread, reference)).instructions.includes(join(config, "opencode", "AGENTS.md")));
  } finally {
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfig;
  }
  assert.match((await prepareContext(thread, "List @[./]")).prompt, /src\/file with spaces.ts/);
  await writeFile(join(root, "outside.txt"), "Private fixture");
  await symlink(join(root, "outside.txt"), join(cwd, "outside-link"));
  await assert.rejects(prepareContext(thread, "@[outside-link]"), /outside this workspace/);
  await assert.rejects(prepareContext(thread, "@[src/file with spaces.ts]#L2-L9999"), /2,000 lines/);
  await assert.rejects(prepareContext(thread, "@[src/file with spaces.ts]#L2-L20"), /outside the available excerpt/);
  await writeFile(join(cwd, "binary"), Buffer.from([0, 1, 2]));
  await assert.rejects(prepareContext(thread, "@[binary]"), /binary files/);
  await rm(join(cwd, "binary"));
  await rm(join(cwd, "outside-link"));
});

test("worktree handoff copies binary and untracked changes without moving the source index", async () => {
  await writeFile(join(cwd, "src", "file with spaces.ts"), "modified\n");
  git(cwd, "add", "src/file with spaces.ts");
  await writeFile(join(cwd, "image.dat"), Buffer.from([0, 255, 254, 1]));
  const terminal = openPanel(project.id, "terminal", thread.id);
  await terminals.open(terminal.id, cwd, 80, 24, "sleep 30");
  await assert.rejects(copyToWorktree(thread), /running terminals/);
  assert.equal(thread.workspacePath, undefined);
  await terminals.close(terminal.id);
  await copyToWorktree(thread);
  assert.ok(!panelList().some(panel => panel.kind === "terminal" && panel.threadId === thread.id));
  const target = thread.workspacePath;
  assert.notEqual(target, cwd);
  assert.equal(await readFile(join(target, "src/file with spaces.ts"), "utf8"), "modified\n");
  assert.deepEqual(await readFile(join(target, "image.dat")), Buffer.from([0, 255, 254, 1]));
  assert.match(git(cwd, "diff", "--cached"), /modified/);
  assert.equal(git(target, "diff", "--cached"), "");
  store.patchThread(thread.id, { archived: true });
  await assert.rejects(removeWorktree(thread), /changes and ignored files/);
  git(target, "add", ".");
  git(target, "commit", "-m", "Keep copied changes");
  await terminals.closeAll();
  await removeWorktree(thread);
  assert.equal(thread.workspacePath, cwd);
  await assert.rejects(readFile(join(target, "image.dat")), /ENOENT/);
  assert.equal(await readFile(join(cwd, "src/file with spaces.ts"), "utf8"), "modified\n");
});

test.after(async () => { await terminals.closeAll(); store.flush(); eventJournal.close(); await pause(100); await rm(root, { recursive: true, force: true }); });
