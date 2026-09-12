import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

test("AI writing uses isolated provider sessions and commits only the intended snapshot", { timeout: 60000 }, async (t) => {
  const directory = fs.mkdtempSync(join(os.tmpdir(), "citropy-assistance-"));
  const originalHome = os.homedir;
  const originalPath = process.env.PATH;
  os.homedir = () => directory;
  syncBuiltinESMExports();
  const bin = join(directory, "bin");
  fs.mkdirSync(bin);
  process.env.PATH = `${bin}:${originalPath}`;
  const log = join(directory, "calls.jsonl");
  for (const provider of ["claude", "codex", "opencode"]) fs.writeFileSync(join(bin, provider), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const provider = ${JSON.stringify(provider)};
const directory = ${JSON.stringify(directory)};
const log = ${JSON.stringify(log)};
if (args.includes("--version")) { process.stdout.write("1.0.0"); process.exit(0); }
const record = (extra) => fs.appendFileSync(log, JSON.stringify({ provider, args, cwd: process.cwd(), ...extra }) + "\\n");
const answer = (prompt) => ({ title: prompt.includes("title for this conversation") ? "Fix workspace icon" : "Fix workspace selection", body: prompt.includes("title for this conversation") ? "" : "Keep the selected workspace visible." });
if (args[0] === "serve") {
  record({ config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) });
  const server = require("node:http").createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    record({ route: req.url, body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/session") res.end(JSON.stringify({ id: "writing" }));
    else if (req.url.endsWith("/message")) res.end(JSON.stringify({ info: {}, parts: [{ type: "text", text: JSON.stringify(answer(body.parts[0].text)) }] }));
    else res.end("{}");
  });
  server.listen(0, "127.0.0.1", () => process.stdout.write("http://127.0.0.1:" + server.address().port + "\\n"));
} else {
  let prompt = "";
  process.stdin.on("data", chunk => prompt += chunk);
  process.stdin.on("end", () => {
    record({ prompt });
    setTimeout(() => {
      if (fs.existsSync(directory + "/fail")) { process.stderr.write("Writing failed"); process.exit(1); }
      const result = answer(prompt);
      if (provider === "codex") fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify(result));
      else process.stdout.write(JSON.stringify({ structured_output: result }));
    }, fs.existsSync(directory + "/delay") ? 250 : 0);
  });
}
`, { mode: 0o755 });
  const { store } = await import("../server/store.ts");
  const { generateText, stopTextGeneration } = await import("../server/text-generation.ts");
  const { configureAssistance, generateThreadTitle, startGitAction, workspaceGitBusy } = await import("../server/assistance.ts");
  const { waitForStoppedProcesses } = await import("../server/providers/process.ts");
  const git = await import("../server/git.ts");
  const providers = ["claude", "codex", "opencode"].map((id) => ({ id, available: true, enabled: true, models: [{ id: id === "opencode" ? "example/model" : "test-model", label: "Test model" }] }));
  const repo = join(directory, "repository");
  fs.mkdirSync(repo);
  const runGit = async (...args) => (await exec("git", args, { cwd: repo })).stdout.trim();
  await runGit("init", "-b", "main");
  await runGit("config", "user.name", "Test");
  await runGit("config", "user.email", "test@example.test");
  fs.writeFileSync(join(repo, "one.txt"), "before\n");
  fs.writeFileSync(join(repo, "two.txt"), "before\n");
  await runGit("add", "-A");
  await runGit("commit", "-m", "Initial state");
  const remote = join(directory, "remote.git");
  await exec("git", ["init", "--bare", remote]);
  await runGit("remote", "add", "origin", remote);
  await runGit("push", "-u", "origin", "main");
  const project = store.openProject(repo);
  const thread = store.createThread({ projectId: project.id, provider: "claude", model: "test-model", title: "First message" });
  const settle = async () => {
    for (let i = 0; i < 500; i++) {
      if (!workspaceGitBusy(repo)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Git action did not finish");
  };
  t.after(async () => {
    stopTextGeneration();
    await waitForStoppedProcesses();
    store.flush();
    os.homedir = originalHome;
    process.env.PATH = originalPath;
    syncBuiltinESMExports();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await t.test("all three providers return structured text without repository tools or persisted coding sessions", async () => {
    for (const provider of providers) {
      const result = await generateText({ provider: provider.id, model: provider.models[0].id }, "Write a title for this conversation", "/run-dangerous-skill");
      assert.equal(result.title, "Fix workspace icon");
    }
    const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    for (const call of calls) {
      assert.notEqual(call.cwd, repo);
      assert.equal(fs.existsSync(call.cwd), false);
    }
    const claude = calls.find((call) => call.provider === "claude");
    assert.equal(claude.args[claude.args.indexOf("--tools") + 1], "");
    for (const flag of ["--disable-slash-commands", "--strict-mcp-config", "--no-session-persistence"]) assert.ok(claude.args.includes(flag));
    assert.equal(JSON.parse(claude.args[claude.args.indexOf("--settings") + 1]).disableAllHooks, true);
    assert.ok(claude.prompt.startsWith("Write a title"));
    const codex = calls.find((call) => call.provider === "codex");
    for (const flag of ["--ephemeral", "--ignore-user-config", "--ignore-rules", "features.shell_tool=false", "features.apply_patch_freeform=false"]) assert.ok(codex.args.includes(flag));
    assert.equal(codex.args[codex.args.indexOf("--sandbox") + 1], "read-only");
    const session = calls.find((call) => call.route === "/session");
    assert.deepEqual(session.body.permission, [{ permission: "*", pattern: "*", action: "deny" }]);
    assert.deepEqual(calls.find((call) => call.route?.endsWith("/message")).body.tools, { "*": false });
    assert.equal(await runGit("status", "--porcelain"), "");
  });

  await t.test("settings persist both model choices without overwriting existing preferences", () => {
    store.setComputerEnabled(true);
    const next = configureAssistance({ titleModel: { provider: "codex", model: "test-model" }, commitModel: { provider: "claude", model: "test-model" }, automaticTitles: false }, providers);
    store.configureNotifications({ sound: true });
    store.setProviderEnabled("opencode", false);
    const saved = JSON.parse(fs.readFileSync(join(directory, ".citropy/settings.json"), "utf8"));
    assert.deepEqual(saved.assistance, next);
    assert.equal(saved.computerEnabled, true);
    assert.equal(saved.notifications.sound, true);
    assert.throws(() => configureAssistance({ titleModel: { provider: "codex", model: "missing" } }, providers), /available writing model/);
    assert.throws(() => configureAssistance({ automaticTitles: "yes" }, providers), /whether/);
  });

  await t.test("automatic naming respects opt-out and never overwrites a user rename", async () => {
    store.addMessage(thread.id, { id: "first", role: "user", ts: Date.now(), parts: [{ id: "text", kind: "text", text: "Fix the workspace icon" }] });
    await generateThreadTitle(thread.id, true);
    assert.equal(thread.title, "First message");
    configureAssistance({ automaticTitles: true }, providers);
    await generateThreadTitle(thread.id, true);
    assert.equal(thread.title, "Fix workspace icon");
    fs.writeFileSync(join(directory, "delay"), "");
    const pending = generateThreadTitle(thread.id);
    store.organizeThread(thread.id, { title: "My chosen name" });
    await pending;
    assert.equal(thread.title, "My chosen name");
    fs.rmSync(join(directory, "delay"));
  });

  await t.test("a first sent message starts automatic naming and timestamps stay tied to the run", async () => {
    const { ThreadRuntime } = await import("../server/runtime.ts");
    const { providers: adapters } = await import("../server/providers/index.ts");
    const start = adapters.claude.start;
    let emit;
    adapters.claude.start = (options) => {
      emit = options.emit;
      return { send: () => emit({ type: "status", status: "thinking" }), interrupt() {}, dispose() {} };
    };
    const fresh = store.createThread({ projectId: project.id, provider: "claude", model: "test-model", title: "New thread" });
    const runtime = new ThreadRuntime(fresh);
    try {
      await runtime.send("Fix the missing workspace icon");
      const startedAt = fresh.runStartedAt;
      assert.ok(Date.now() - startedAt < 2000);
      emit({ type: "status", status: "working", tool: "Read" });
      assert.equal(fresh.runStartedAt, startedAt);
      for (let i = 0; i < 100 && fresh.title !== "Fix workspace icon"; i++) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(fresh.title, "Fix workspace icon");
      emit({ type: "turn.end" });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await runtime.send("Check it again");
      assert.ok(fresh.runStartedAt > startedAt);
      assert.equal(fresh.title, "Fix workspace icon");
      await runtime.send("Keep this queued follow-up");
      const queued = fresh.queue[0];
      runtime.stop();
      fs.writeFileSync(join(repo, "queue-check.txt"), "A change to commit\n");
      startGitAction(fresh.id, "commit", "all");
      await runtime.sendNow(queued.id);
      assert.deepEqual(fresh.queue, [queued]);
      assert.equal(fresh.messages.some((message) => message.parts.some((part) => part.kind === "text" && part.text === queued.text)), false);
      await settle();
    } finally {
      runtime.dispose();
      adapters.claude.start = start;
      store.removeThread(fresh.id);
    }
  });

  await t.test("staged changes stay separate and an all-changes commit can push to a local upstream", async () => {
    fs.writeFileSync(join(repo, "one.txt"), "staged\n");
    fs.writeFileSync(join(repo, "two.txt"), "unstaged\n");
    await runGit("add", "one.txt");
    startGitAction(thread.id, "commit", "staged");
    assert.throws(() => startGitAction(thread.id, "commit", "staged"), /already running/);
    await settle();
    assert.equal(thread.gitAction.status, "success", thread.gitAction.message);
    assert.equal(await runGit("show", "HEAD:one.txt"), "staged");
    assert.equal(await runGit("show", "HEAD:two.txt"), "before");
    assert.equal(await runGit("diff", "--cached"), "");
    assert.equal(await runGit("log", "-1", "--format=%B"), "Fix workspace selection\n\nKeep the selected workspace visible.");
    startGitAction(thread.id, "commitPush", "all");
    await settle();
    assert.equal(thread.gitAction.status, "success", thread.gitAction.message);
    assert.equal(await runGit("status", "--porcelain"), "");
    assert.equal(await runGit("rev-parse", "HEAD"), (await exec("git", ["--git-dir", remote, "rev-parse", "main"])).stdout.trim());
  });

  await t.test("generation failures and changed snapshots leave files and the index intact", async () => {
    fs.writeFileSync(join(repo, "one.txt"), "next\n");
    const before = await runGit("rev-parse", "HEAD");
    const index = await runGit("write-tree");
    fs.writeFileSync(join(directory, "fail"), "");
    startGitAction(thread.id, "commit", "all");
    await settle();
    fs.rmSync(join(directory, "fail"));
    assert.equal(thread.gitAction.status, "error");
    assert.equal(await runGit("write-tree"), index);
    assert.equal(await runGit("rev-parse", "HEAD"), before);
    await assert.rejects(git.assistedCommit(repo, "all", false, async () => {
      fs.writeFileSync(join(repo, "one.txt"), "changed during generation\n");
      return "Old snapshot";
    }, () => {}, () => {}), /changes moved/);
    assert.equal(await runGit("rev-parse", "HEAD"), before);
    assert.equal(await runGit("write-tree"), index);
    await assert.rejects(git.assistedCommit(repo, "all", false, async () => {
      await runGit("add", "one.txt");
      return "Changed staging";
    }, () => {}, () => {}), /changes moved/);
    assert.equal(await runGit("rev-parse", "HEAD"), before);
  });

  await t.test("hooks remain enabled and failed pushes retain the completed commit", async () => {
    const hook = join(repo, ".git/hooks/pre-commit");
    fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const before = await runGit("rev-parse", "HEAD");
    startGitAction(thread.id, "commit", "staged");
    await settle();
    assert.equal(thread.gitAction.status, "error");
    assert.equal(await runGit("rev-parse", "HEAD"), before);
    fs.rmSync(hook);
    fs.writeFileSync(join(remote, "hooks/pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    startGitAction(thread.id, "commitPush", "staged");
    await settle();
    assert.equal(thread.gitAction.status, "error");
    assert.ok(thread.gitAction.commit);
    assert.match(thread.gitAction.message, /Committed successfully, but the push failed/);
    const committed = await runGit("rev-parse", "HEAD");
    assert.notEqual(committed, before);
    fs.rmSync(join(remote, "hooks/pre-receive"));
    startGitAction(thread.id, "push", "all");
    await settle();
    assert.equal(thread.gitAction.status, "success", thread.gitAction.message);
    assert.equal(await runGit("rev-parse", "HEAD"), committed);
  });

  await t.test("active agents prevent Git actions in their own workspace", () => {
    store.patchThread(thread.id, { running: true, status: "thinking" });
    assert.throws(() => startGitAction(thread.id, "push", "all"), /agents.*finish/);
    store.patchThread(thread.id, { running: false, status: "idle" });
  });

  await t.test("push shortcuts ignore matching-branch defaults and push only the chosen branch", async () => {
    await runGit("branch", "unrelated");
    await runGit("push", "origin", "unrelated");
    await runGit("switch", "unrelated");
    fs.writeFileSync(join(repo, "other.txt"), "Do not publish this branch\n");
    await runGit("add", "other.txt");
    await runGit("commit", "-m", "Unrelated work");
    const localOther = await runGit("rev-parse", "unrelated");
    await runGit("switch", "main");
    await runGit("config", "push.default", "matching");
    startGitAction(thread.id, "push", "all");
    await settle();
    assert.equal(thread.gitAction.status, "success", thread.gitAction.message);
    const remoteOther = (await exec("git", ["--git-dir", remote, "rev-parse", "unrelated"])).stdout.trim();
    assert.notEqual(localOther, remoteOther);
    assert.equal(await runGit("rev-parse", "HEAD"), (await exec("git", ["--git-dir", remote, "rev-parse", "main"])).stdout.trim());
  });
});
