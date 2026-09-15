import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assistedCommit } from "../server/git.ts";

const exec = promisify(execFile);

async function repository(t, files) {
  const cwd = await mkdtemp(join(tmpdir(), "citropy-commit-context-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = async (...args) => (await exec("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 })).stdout;
  const write = async (path, text) => {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), text);
  };
  await git("init", "-b", "main");
  await git("config", "user.name", "Citropy Test");
  await git("config", "user.email", "test@example.invalid");
  for (const [path, text] of Object.entries(files)) await write(path, text);
  await git("add", "-A");
  await git("commit", "-m", "Initial state");
  return { cwd, git, write };
}

test("large AI commit diffs retain small fixes after the old cutoff", async (t) => {
  const files = {
    "a-feature.ts": "export const enabled = false;\n",
    "web/Working.tsx": "const start = Date.now();\nconst elapsed = now - start;\n",
    "web/sidebar.css": ".category-icon { color: var(--task-icon); }\n",
  };
  const repo = await repository(t, files);
  await repo.write("a-feature.ts", Array.from({ length: 2000 }, (_, index) => `export const feature${index} = { enabled: true, title: "AI assistance ${index}" };\n`).join(""));
  await repo.write("web/Working.tsx", "const start = thread.runStartedAt;\nconst elapsed = now - start;\n");
  await repo.write("web/sidebar.css", `${files["web/sidebar.css"]}.thread-category[data-category="pinned"] .category-icon { color: var(--warn); }\n`);
  let context;
  await assistedCommit(repo.cwd, "all", false, async (value) => {
    context = value;
    assert.ok(value.diff.length <= 60000);
    assert.equal(value.truncated, true);
    assert.match(value.diff, /\+export const feature0 /);
    assert.match(value.diff, /\+export const feature1999 /);
    assert.match(value.diff, /\+const start = thread\.runStartedAt;/);
    assert.match(value.diff, /\+\.thread-category\[data-category="pinned"\].*var\(--warn\)/);
    for (const path of Object.keys(files)) assert.ok(value.diff.includes(`diff --git a/${path} b/${path}`));
    return "Add AI assistance and fix timer and pinned colors";
  }, () => {}, () => {});
  const patch = await repo.git("diff", "HEAD^", "HEAD", "--no-color");
  assert.ok(patch.indexOf("+const start = thread.runStartedAt;") > 60000);
  assert.ok(context.diff.length < patch.length);
  assert.equal((await repo.git("status", "--porcelain")).trim(), "");
});

test("large files retain separate later hunks in AI commit context", async (t) => {
  const gap = Array.from({ length: 20 }, (_, index) => `const unchanged${index} = ${index};\n`).join("");
  const before = `const feature = false;\n${gap}const timer = Date.now();\n${gap}const pinned = "purple";\n`;
  const repo = await repository(t, { "changes.ts": before });
  const feature = Array.from({ length: 2000 }, (_, index) => `const feature${index} = "A newly enabled feature with value ${index}";\n`).join("");
  await repo.write("changes.ts", `${feature}${gap}const timer = thread.runStartedAt;\n${gap}const pinned = "amber";\n`);
  await assistedCommit(repo.cwd, "all", false, async (context) => {
    assert.ok(context.diff.length <= 60000);
    assert.equal(context.truncated, true);
    assert.equal(context.diff.match(/^@@ /gm).length, 3);
    assert.match(context.diff, /\+const timer = thread\.runStartedAt;/);
    assert.match(context.diff, /\+const pinned = "amber";/);
    return "Add features and preserve timer and pinned state";
  }, () => {}, () => {});
});

test("small staged diffs stay complete and do not include unstaged changes", async (t) => {
  const repo = await repository(t, { "one.txt": "before\n", "two.txt": "before\n" });
  await repo.write("one.txt", "staged\n");
  await repo.git("add", "one.txt");
  await repo.write("one.txt", "unstaged\n");
  await repo.write("two.txt", "also unstaged\n");
  const expected = await repo.git("diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3");
  await assistedCommit(repo.cwd, "staged", false, async (context) => {
    assert.equal(context.diff, expected);
    assert.equal(context.truncated, false);
    assert.doesNotMatch(context.diff, /unstaged|two\.txt/);
    return "Update the staged file";
  }, () => {}, () => {});
  assert.equal((await repo.git("show", "HEAD:one.txt")).trim(), "staged");
  assert.match(await repo.git("diff"), /unstaged/);
});

test("AI commit context preserves full paths, renames, and binary changes", async (t) => {
  const path = `source/${"long-folder-name/".repeat(8)}module.ts`;
  const repo = await repository(t, { [path]: "before\n", "old name.txt": "rename me\n", "icon.png": Buffer.from([0, 1, 2, 3]) });
  await repo.write(path, "after\n");
  await repo.git("mv", "old name.txt", "new name.txt");
  await repo.write("icon.png", Buffer.from([0, 4, 5, 6]));
  await assistedCommit(repo.cwd, "all", false, async (context) => {
    assert.equal(context.truncated, false);
    assert.ok(context.summary.includes(path));
    assert.match(context.summary, /rename old name\.txt => new name\.txt/);
    assert.match(context.diff, /rename from old name\.txt\nrename to new name\.txt/);
    assert.match(context.diff, /Binary files a\/icon\.png and b\/icon\.png differ/);
    return "Update the module and icon and rename the text file";
  }, () => {}, () => {});
});

test("change sets that cannot fit their inventory fail before generation or staging", async (t) => {
  const repo = await repository(t, { "original.txt": "unchanged\n" });
  const head = await repo.git("rev-parse", "HEAD");
  const index = await repo.git("write-tree");
  for (let i = 0; i < 140; i++) await repo.write(`${String(i).padStart(3, "0")}-${"long-name-".repeat(9)}.txt`, "new file\n");
  let generated = false;
  await assert.rejects(assistedCommit(repo.cwd, "all", false, async () => {
    generated = true;
    return "Incomplete summary";
  }, () => {}, () => {}), /too large to summarize completely/);
  assert.equal(generated, false);
  assert.equal(await repo.git("rev-parse", "HEAD"), head);
  assert.equal(await repo.git("write-tree"), index);
  assert.equal((await repo.git("ls-files", "--others", "--exclude-standard")).trim().split("\n").length, 140);
});
