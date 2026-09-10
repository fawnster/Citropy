import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FilePatch, GitFile, GitStatus } from "../shared/protocol.ts";
import { parseUnifiedDiff } from "./diff.ts";

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

async function tryGit(cwd: string, args: string[]): Promise<string> {
  try {
    return await git(cwd, args);
  } catch (error) {
    if (args.includes("--no-index") && (error as { code?: number }).code === 1) return String((error as { stdout?: string }).stdout ?? "");
    return "";
  }
}

export async function isRepo(cwd: string): Promise<boolean> {
  const out = await tryGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return out.trim() === "true";
}

export async function status(cwd: string): Promise<GitStatus> {
  const porcelain = await tryGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const branchLine = (await tryGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
  const counts = await numstat(cwd);

  const files: GitFile[] = [];
  const records = porcelain.split("\0").filter(Boolean);
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record || record.length < 3) continue;
    const index = record[0] ?? " ";
    const work = record[1] ?? " ";
    let path = record.slice(3);
    if ([index, work].some((value) => value === "R" || value === "C")) {
      i += 1;

    }
    const stat = counts.get(path) ?? { added: 0, removed: 0 };
    files.push({
      path,
      index,
      work,
      added: stat.added,
      removed: stat.removed,
      staged: index !== " " && index !== "?",
      untracked: index === "?",
    });
  }

  let ahead = 0;
  let behind = 0;
  const tracking = (await tryGit(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])).trim();
  if (tracking) {
    const [b, a] = tracking.split(/\s+/);
    behind = Number(b ?? 0);
    ahead = Number(a ?? 0);
  }

  files.sort((x, y) => x.path.localeCompare(y.path));
  return { branch: branchLine || "detached", ahead, behind, files, clean: files.length === 0 };
}

async function numstat(cwd: string): Promise<Map<string, { added: number; removed: number }>> {
  const map = new Map<string, { added: number; removed: number }>();
  for (const args of [["diff", "--numstat"], ["diff", "--numstat", "--cached"]]) {
    const out = await tryGit(cwd, args);
    for (const line of out.split("\n")) {
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const path = parts[2] ?? "";
      const prev = map.get(path) ?? { added: 0, removed: 0 };
      map.set(path, {
        added: prev.added + (Number(parts[0]) || 0),
        removed: prev.removed + (Number(parts[1]) || 0),
      });
    }
  }
  return map;
}

export async function fileDiff(cwd: string, path: string, staged: boolean): Promise<FilePatch | null> {
  const conflicted = !staged && Boolean((await git(cwd, ["ls-files", "--unmerged", "--", path])).trim());
  const args = staged
    ? ["diff", "--cached", "--no-color", "--", path]
    : ["diff", ...(conflicted ? ["--base"] : []), "--no-color", "--", path];
  let out = await tryGit(cwd, args);
  if (!out.trim() && !staged && (await git(cwd, ["ls-files", "--others", "--exclude-standard", "--", path])).trim()) {
    out = await tryGit(cwd, ["diff", "--no-index", "--no-color", "--", "/dev/null", path]);
  }
  if (!out.trim()) return null;
  const patches = parseUnifiedDiff(out, path);
  return patches[0] ?? null;
}

export async function stage(cwd: string, path: string, staged: boolean): Promise<void> {
  if (staged) await git(cwd, ["add", "--", path]);
  else if ((await tryGit(cwd, ["rev-parse", "--verify", "HEAD"])).trim()) await git(cwd, ["restore", "--staged", "--", path]);
  else await git(cwd, ["rm", "--cached", "--", path]);
}

export async function discard(cwd: string, path: string): Promise<void> {
  await tryGit(cwd, ["restore", "--staged", "--worktree", "--", path]);
  await tryGit(cwd, ["clean", "-fd", "--", path]);
}

export async function commit(cwd: string, message: string): Promise<string> {
  await git(cwd, ["add", "-A"]);
  const out = await git(cwd, ["commit", "-m", message]);
  return out.trim();
}

export async function branch(cwd: string): Promise<string> {
  return (await tryGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
}

export async function overview(cwd: string, offset = 0): Promise<import("../shared/protocol.ts").GitOverview> {
  if (!await isRepo(cwd)) return { repository: false, hasCommits: false, mergeInProgress: false, branches: [], commits: [], remotes: [], stashes: [] };
  const [working, refs, log, remoteNames, stash, head, mergeHead] = await Promise.all([
    status(cwd),
    git(cwd, ["for-each-ref", "--format=%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(refname)%09%(committerdate:iso-strict)%09%(subject)", "refs/heads", "refs/remotes"]),
    tryGit(cwd, ["log", "--date=iso-strict", "--format=%H%x00%an%x00%aI%x00%s%x00%D", "-z", "-50", `--skip=${Math.max(0, Math.floor(offset))}`]),
    git(cwd, ["remote"]),
    git(cwd, ["stash", "list", "--format=%gd%x09%s"]),
    tryGit(cwd, ["rev-parse", "--verify", "HEAD"]),
    tryGit(cwd, ["rev-parse", "--verify", "MERGE_HEAD"]),
  ]);
  const fields = log.split("\0");
  const commits: import("../shared/protocol.ts").GitOverview["commits"] = [];
  for (let index = 0; index + 4 < fields.length; index += 5) {
    const [hash = "", author = "", date = "", subject = "", refs = ""] = fields.slice(index, index + 5);
    commits.push({ hash, author, date, subject, refs });
  }
  const remotes = await Promise.all(remoteNames.trim().split("\n").filter(Boolean).map(async (name) => ({ name, url: (await git(cwd, ["remote", "get-url", name])).trim() })));
  return {
    repository: true, hasCommits: Boolean(head.trim()), mergeInProgress: Boolean(mergeHead.trim()), status: working, commits, remotes,
    branches: refs.trim().split("\n").filter(Boolean).map((line) => { const [name = "", head, upstream = "", ref = "", date = "", ...subject] = line.split("\t"); return { name, current: head === "*", upstream, remote: ref.startsWith("refs/remotes/"), date, subject: subject.join("\t") }; }),
    stashes: stash.trim().split("\n").filter(Boolean).map((line) => { const [ref = "", ...subject] = line.split("\t"); return { ref, subject: subject.join("\t") }; }),
  };
}

async function runOperation(cwd: string, operation: import("../shared/protocol.ts").GitOperation, value = "", offset = 0, remote = ""): Promise<import("../shared/protocol.ts").GitResult> {
  if (operation === "overview" || operation === "history") return overview(cwd, offset);
  if (operation === "init") return git(cwd, ["init"]);
  if (!await isRepo(cwd)) throw new Error("This workspace is not a Git repository.");
  if (["createBranch", "switchBranch", "deleteBranch", "merge"].includes(operation)) {
    if (!value || value.startsWith("-")) throw new Error("Choose a valid branch name.");
    await git(cwd, ["check-ref-format", "--branch", value]);
  }
  if (["applyStash", "dropStash", "showStash"].includes(operation) && !/^stash@\{\d+\}$/.test(value)) throw new Error("Choose a valid stash.");
  switch (operation) {
    case "show": {
      if (!/^[a-f0-9]{40,64}$/.test(value)) throw new Error("Choose a commit from history.");
      const [patch, message] = await Promise.all([
        git(cwd, ["show", "--no-ext-diff", "--no-color", "--format=", "--first-parent", "--patch", value, "--"]),
        git(cwd, ["show", "--no-patch", "--format=%B", value, "--"]),
      ]);
      return { kind: "detail", message: message.trim(), patches: parseUnifiedDiff(patch) };
    }
    case "showStash": {
      const patch = await git(cwd, ["stash", "show", "--no-ext-diff", "--no-color", "--include-untracked", "--patch", value]);
      return { kind: "detail", message: "", patches: parseUnifiedDiff(patch) };
    }
    case "discardWorktree": {
      if (!value) throw new Error("Choose a file.");
      const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "--", value])).trim();
      return untracked ? git(cwd, ["clean", "-f", "--", value]) : git(cwd, ["restore", "--worktree", "--", value]);
    }
    case "stage": await stage(cwd, value, true); return "Staged file";
    case "unstage": await stage(cwd, value, false); return "Unstaged file";
    case "stageAll": return git(cwd, ["add", "-A"]);
    case "unstageAll":
      return (await tryGit(cwd, ["rev-parse", "--verify", "HEAD"])).trim() ? git(cwd, ["reset", "--mixed", "HEAD"]) : git(cwd, ["rm", "--cached", "-r", "--", "."]);
    case "commit":
      if (!value.trim()) throw new Error("Enter a commit message.");
      return git(cwd, ["commit", "-m", value]);
    case "createBranch": return git(cwd, ["switch", "-c", value]);
    case "switchBranch": return git(cwd, ["switch", value]);
    case "deleteBranch": return git(cwd, ["branch", "-d", value]);
    case "merge": return git(cwd, ["merge", "--no-edit", value]);
    case "abortMerge": return git(cwd, ["merge", "--abort"]);
    case "addRemote":
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote) || !value.trim() || value.startsWith("-")) throw new Error("Enter a remote name and URL.");
      return git(cwd, ["remote", "add", remote, value]);
    case "removeRemote":
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error("Choose a remote.");
      return git(cwd, ["remote", "remove", value]);
    case "publish": {
      const names = (await git(cwd, ["remote"])).trim().split("\n");
      if (!names.includes(value) || value.startsWith("-")) throw new Error("Choose a configured remote.");
      const current = (await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
      return git(cwd, ["push", "--set-upstream", value, current]);
    }
    case "fetch": return git(cwd, ["fetch", "--all", "--prune"]);
    case "pull": return git(cwd, ["pull", "--ff-only"]);
    case "push": return git(cwd, ["push"]);
    case "stash": return git(cwd, ["stash", "push", "--include-untracked", "-m", value || "Saved from Citropy"]);
    case "applyStash": return git(cwd, ["stash", "apply", value]);
    case "dropStash": return git(cwd, ["stash", "drop", value]);
    default: throw new Error("Unsupported Git action");
  }
}

const operations = new Map<string, Promise<unknown>>();

export async function manage(cwd: string, operation: import("../shared/protocol.ts").GitOperation, value = "", offset = 0, remote = "") {
  const previous = operations.get(cwd) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => runOperation(cwd, operation, value, offset, remote));
  operations.set(cwd, next);
  try { return await next; }
  finally { if (operations.get(cwd) === next) operations.delete(cwd); }
}
