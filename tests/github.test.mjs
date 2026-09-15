import assert from "node:assert/strict";
import { test } from "node:test";
import childProcess from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { syncBuiltinESMExports } from "node:module";

test("GitHub integration validates targets, paginates, preserves request bodies, and clones without overwriting", async (t) => {
  const directory = fs.mkdtempSync(join(os.tmpdir(), "citropy-github-"));
  const originalHome = os.homedir;
  const originalExec = childProcess.execFile;
  const calls = [];
  let chooser = directory;
  let respond = () => ({});
  os.homedir = () => directory;
  childProcess.execFile = Object.assign((binary, args, options, callback) => {
    const stdin = new PassThrough();
    let body = "";
    stdin.on("data", (chunk) => { body += String(chunk); });
    stdin.on("finish", () => {
      const call = { binary, args, options, body: body ? JSON.parse(body) : undefined };
      calls.push(call);
      try {
        const result = respond(call);
        callback(null, typeof result === "string" ? result : JSON.stringify(result), "");
      } catch (error) { callback(error, "", error.message); }
    });
    return { stdin };
  }, { [promisify.custom]: async (binary) => {
    assert.equal(binary, "kdialog");
    if (!chooser) throw Object.assign(new Error("cancelled"), { code: 1 });
    return { stdout: `${chooser}\n`, stderr: "" };
  } });
  syncBuiltinESMExports();
  const { handleGitHub, repositoryName, repositoryFromRemote } = await import("../server/github.ts");
  t.after(async () => {
    const { store } = await import("../server/store.ts");
    store.flush();
    childProcess.execFile = originalExec;
    os.homedir = originalHome;
    syncBuiltinESMExports();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await t.test("recognizes GitHub remotes and rejects option injection and filesystem paths", async () => {
    for (const url of ["https://github.com/team/repo.git", "git@github.com:team/repo.git", "ssh://git@github.com/team/repo.git"]) assert.equal(repositoryFromRemote(url), "team/repo");
    assert.equal(repositoryFromRemote("https://github.com.evil.test/team/repo"), null);
    for (const value of ["--help", "owner/../repo", "/tmp/repo", "owner/..", "owner/repo;touch bad", "owner/repo\n"]) assert.throws(() => repositoryName(value));
    await assert.rejects(handleGitHub({ operation: "detail", repo: "owner/repo", number: -1, pull: true }));
    assert.equal(calls.length, 0);
  });
  await t.test("search covers repositories shared with the signed-in account", async () => {
    respond = (call) => {
      assert.ok(call.args.includes("--paginate"));
      return [[{ id: 1, full_name: "team/shared", description: "Shared project" }], [{ id: 2, full_name: "me/personal", description: "Other" }]];
    };
    const result = await handleGitHub({ operation: "repositories", scope: "mine", query: "shared" });
    assert.deepEqual(result.items.map((repo) => repo.full_name), ["team/shared"]);
    assert.equal(result.total, 1);
    assert.equal(result.more, false);
  });
  await t.test("publishing sends exact Markdown on stdin and merging requires the reviewed commit", async () => {
    respond = () => ({ number: 42, html_url: "https://github.com/owner/repo/issues/42" });
    const body = "Two paragraphs.\n\n`$HOME` and $(literal) stay literal.";
    const result = await handleGitHub({ operation: "mutate", repo: "owner/repo", mutation: { action: "createIssue", title: "A title", body, labels: ["bug"], assignees: ["me"] } });
    assert.match(result.message, /42/);
    assert.equal(calls.at(-1).body.body, body);
    assert.ok(calls.at(-1).args.includes("--input"));
    assert.ok(!calls.at(-1).args.includes(body));
    assert.equal(calls.at(-1).options.env.GH_PROMPT_DISABLED, "1");
    const sha = "a".repeat(40);
    respond = () => ({ merged: false, message: "Head branch was modified" });
    await assert.rejects(handleGitHub({ operation: "mutate", repo: "owner/repo", mutation: { action: "merge", number: 42, method: "squash", sha } }), /Head branch was modified/);
    assert.equal(calls.at(-1).body.sha, sha);
    await assert.rejects(handleGitHub({ operation: "mutate", repo: "owner/repo", mutation: { action: "merge", number: 42, method: "squash", sha: "" } }), /Refresh/);
    respond = () => ({ merged: true });
    assert.match((await handleGitHub({ operation: "mutate", repo: "owner/repo", mutation: { action: "merge", number: 42, method: "squash", sha } })).message, /merged/);
  });
  await t.test("pull request detail combines all comments, reviews, files, and both check formats", async () => {
    respond = (call) => {
      const endpoint = call.args.at(-1);
      if (endpoint.endsWith("/pulls/7")) return { number: 7, head: { sha: "abc" } };
      if (endpoint.includes("/comments")) return [[{ id: 1 }], [{ id: 2 }]];
      if (endpoint.includes("/reviews")) return [[{ id: 3 }]];
      if (endpoint.includes("/files")) return [[{ filename: "one.ts" }], [{ filename: "two.ts" }]];
      if (endpoint.includes("/check-runs")) return [{ check_runs: [{ id: 4 }] }, { check_runs: [{ id: 5 }] }];
      if (endpoint.includes("/status")) return [{ statuses: [{ id: 6 }] }];
      throw new Error(`Unexpected endpoint ${endpoint}`);
    };
    const result = await handleGitHub({ operation: "detail", repo: "owner/repo", number: 7, pull: true });
    assert.equal(result.comments.length, 2);
    assert.equal(result.files.length, 2);
    assert.equal(result.reviews.length, 1);
    assert.equal(result.checks.length, 2);
    assert.equal(result.statuses.length, 1);
  });
  await t.test("cloning respects cancellation and never writes over an existing folder", async () => {
    chooser = null;
    const before = calls.length;
    assert.deepEqual(await handleGitHub({ operation: "clone", repo: "owner/repo" }), { project: null });
    assert.equal(calls.length, before);
    chooser = directory;
    fs.mkdirSync(join(directory, "repo"));
    fs.writeFileSync(join(directory, "repo", "keep.txt"), "keep");
    await assert.rejects(handleGitHub({ operation: "clone", repo: "owner/repo" }), /already exists/);
    assert.equal(fs.readFileSync(join(directory, "repo", "keep.txt"), "utf8"), "keep");
    assert.equal(calls.length, before);
    respond = (call) => { assert.deepEqual(call.args, ["repo", "clone", "owner/fresh", join(directory, "fresh")]); return ""; };
    const result = await handleGitHub({ operation: "clone", repo: "owner/fresh" });
    assert.equal(result.project.path, join(directory, "fresh"));
  });

  await t.test("cloning uses the selected destination without opening a server-side folder dialog", async () => {
    const parent = join(directory, "Selected destination");
    fs.mkdirSync(parent);
    chooser = null;
    respond = call => {
      assert.deepEqual(call.args, ["repo", "clone", "owner/selected", join(parent, "selected")]);
      assert.equal(call.options.cwd, parent);
      return "";
    };
    const result = await handleGitHub({ operation: "clone", repo: "owner/selected", parent });
    assert.equal(result.project.path, join(parent, "selected"));
    await assert.rejects(handleGitHub({ operation: "clone", repo: "owner/selected", parent }), /already exists/);
    await assert.rejects(handleGitHub({ operation: "clone", repo: "owner/selected", parent: join(directory, "missing") }), /ENOENT/);
  });

  await t.test("publishing checks local history and existing remotes before creating anything on GitHub", async () => {
    const { store } = await import("../server/store.ts");
    const project = store.openProject(join(directory, "fresh"));
    const request = { operation: "publishRepository", projectId: project.id, name: "published", description: "Description", private: true };
    let remote = "";
    let committed = false;
    const before = calls.length;
    respond = (call) => {
      if (call.binary === "git") {
        if (call.args[0] === "rev-parse") { if (!committed) throw new Error("No commits"); return "a".repeat(40); }
        if (call.args[0] === "remote") return remote;
        if (call.args[0] === "branch") return "main";
      }
      if (call.args.includes("user")) return { login: "owner" };
      if (call.args.includes("create")) return "https://github.com/owner/published";
      return { full_name: "owner/published" };
    };
    await assert.rejects(handleGitHub(request), /first commit/);
    assert.ok(calls.slice(before).every((call) => call.binary === "git"));
    committed = true;
    remote = "origin";
    await assert.rejects(handleGitHub(request), /already has an origin/);
    assert.ok(calls.slice(before).every((call) => call.binary === "git"));
    remote = "";
    const result = await handleGitHub(request);
    assert.equal(result.full_name, "owner/published");
    const creation = calls.findLast((call) => call.args.includes("create"));
    assert.ok(creation.args.includes("--private"));
    assert.ok(creation.args.includes("--push"));
    assert.equal(creation.options.cwd, project.path);
  });

  await t.test("errors are readable and do not expose credentials", async () => {
    respond = () => { throw new Error("Authentication failed: gho_supersecret123"); };
    const status = await handleGitHub({ operation: "status" });
    assert.match(status.error, /Authentication failed/);
    assert.ok(!status.error.includes("supersecret"));
  });
});
