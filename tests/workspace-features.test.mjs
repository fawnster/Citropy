import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

test("workspace features persist and use conversation boundaries", async (t) => {
  const directory = fs.mkdtempSync(join(os.tmpdir(), "citropy-features-"));
  const originalHome = os.homedir;
  const environment = {
    CODEX_HOME: process.env.CODEX_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  os.homedir = () => directory;
  process.env.CODEX_HOME = join(directory, ".codex");
  process.env.CLAUDE_CONFIG_DIR = join(directory, ".claude");
  process.env.XDG_CONFIG_HOME = join(directory, ".config");
  syncBuiltinESMExports();
  const { store, Store } = await import("../server/store.ts");
  const { handleFeatures } = await import("../server/features.ts");
  const { providers } = await import("../server/providers/index.ts");
  const { runtimeFor, disposeAll } = await import("../server/runtime.ts");
  const { workspacePath } = await import("../server/workspaces.ts");
  const { listSkills, changeSkill } = await import("../server/skills.ts");
  const { MessageUsage } = await import("../server/providers/message-usage.ts");
  const { parseProviderLimits } = await import("../server/usage.ts");
  const { closeAll } = await import("../server/terminals.ts");
  const catalog = [
    {
      id: "claude",
      available: true,
      enabled: true,
      label: "Claude Code",
      models: [
        {
          id: "fixture",
          label: "Fixture",
          isDefault: true,
          efforts: ["low", "high"],
          defaultEffort: "high",
        },
      ],
    },
  ];
  let session;
  providers.claude.models = catalog[0].models;
  providers.claude.start = (options) => {
    session = { options, sent: [], compacted: 0 };
    options.emit({ type: "session", externalId: "fixture-session" });
    return {
      send: async (...args) => session.sent.push(args),
      compact: async () => {
        session.compacted++;
      },
      interrupt() {},
      dispose() {},
    };
  };
  const server = http.createServer((req, res) => {
    void handleFeatures(req, res, catalog);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/`;
  const request = async (path, method = "GET", body) => {
    const response = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  t.after(async () => {
    disposeAll();
    closeAll();
    store.flush();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    os.homedir = originalHome;
    for (const [key, value] of Object.entries(environment))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    syncBuiltinESMExports();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const repo = join(directory, "project with spaces");
  fs.mkdirSync(repo);
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, stdio: "pipe", encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(join(repo, "example.txt"), "Original checkout");
  fs.mkdirSync(join(repo, ".claude/skills/example"), { recursive: true });
  fs.writeFileSync(
    join(repo, ".claude/skills/example/SKILL.md"),
    "---\nname: example\ndescription: Fixture skill\n---\nUse this fixture.",
  );
  git("add", ".");
  git("commit", "-m", "Fixture");
  const project = store.openProject(repo);
  let thread;
  let attachment;
  await t.test(
    "project defaults and worktree creation survive restart",
    async () => {
      const configured = await request(
        `projects?projectId=${project.id}`,
        "PATCH",
        {
          name: "Project",
          settings: {
            provider: "claude",
            model: "fixture",
            effort: "high",
            permissionMode: "plan",
            workspace: "new",
            browserAccess: false,
            actions: [
              {
                id: "tests",
                name: "Tests",
                command: "printf ready > setup-ready",
                setup: true,
              },
            ],
          },
        },
      );
      assert.equal(configured.status, 200);
      assert.equal(configured.data.settings.actions, undefined);
      store.updateProject(project.id, { settings: { ...project.settings, actions: [{ id: "legacy", name: "Legacy setup", command: "printf ready > setup-ready", setup: true }] } });
      const created = await request("threads", "POST", {
        projectId: project.id,
        provider: "claude",
        workspace: { kind: "new", branch: "feature/test" },
      });
      assert.equal(created.status, 200, JSON.stringify(created.data));
      thread = store.threads.get(created.data.id);
      assert.equal(thread.effort, "high");
      assert.equal(thread.permissionMode, "plan");
      assert.notEqual(thread.workspacePath, repo);
      assert.equal(
        fs.readFileSync(join(thread.workspacePath, "example.txt"), "utf8"),
        "Original checkout",
      );
      fs.writeFileSync(
        join(thread.workspacePath, "example.txt"),
        "Separate checkout",
      );
      assert.equal(
        fs.readFileSync(join(repo, "example.txt"), "utf8"),
        "Original checkout",
      );
      assert.equal(fs.existsSync(join(thread.workspacePath, "setup-ready")), false);
      const choices = await request(`workspaces?projectId=${project.id}`);
      assert.equal(choices.data.worktrees.length, 2);
      const existing = await request("threads", "POST", {
        projectId: project.id,
        provider: "claude",
        workspace: { kind: "existing", path: thread.workspacePath },
      });
      assert.equal(existing.data.workspacePath, thread.workspacePath);
      const invalid = await request("threads", "POST", {
        projectId: project.id,
        provider: "claude",
        workspace: { kind: "existing", path: directory },
      });
      assert.equal(invalid.status, 400);
      store.flush();
      assert.equal(
        new Store().threads.get(thread.id).workspacePath,
        thread.workspacePath,
      );
      assert.equal(new Store().projects.get(project.id).settings.model, "fixture");
    },
  );
  await t.test("global defaults inherit, persist, and respect folder overrides", async () => {
    const { callWorkspaceTool } = await import("../server/mcp.ts");
    const { resolveProjectSettings } = await import("../shared/project-settings.ts");
    const original = structuredClone(project.settings);
    const folderPath = join(directory, "inherited folder");
    execFileSync("git", ["clone", repo, folderPath], { stdio: "pipe" });
    const folder = store.openProject(folderPath);
    const defaults = {
      provider: "claude", model: "fixture", effort: "low",
      permissionMode: "acceptEdits", workspace: "new", autoPull: false, browserAccess: false,
    };
    try {
      const configured = await request("projects/defaults", "PATCH", { settings: defaults });
      assert.equal(configured.status, 200);
      assert.deepEqual(configured.data, defaults);
      assert.deepEqual((await request("projects/defaults", "GET")).data, defaults);
      const remoteModel = { ...defaults, provider: "opencode", model: "remote/model", effort: "high" };
      assert.deepEqual((await request("projects/defaults", "PATCH", { settings: remoteModel })).data, remoteModel);
      assert.deepEqual(new Store().projectDefaults, remoteModel);
      assert.equal((await request(`projects?projectId=${folder.id}`, "PATCH", { settings: remoteModel })).status, 400);
      await request("projects/defaults", "PATCH", { settings: defaults });
      assert.deepEqual(store.projects.get(project.id).settings, original);
      assert.equal(store.projects.get(folder.id).settings, undefined);
      const created = await request("threads", "POST", { projectId: folder.id });
      assert.equal(created.status, 200, JSON.stringify(created.data));
      assert.equal(created.data.provider, "claude");
      assert.equal(created.data.model, "fixture");
      assert.equal(created.data.effort, "low");
      assert.equal(created.data.permissionMode, "acceptEdits");
      assert.notEqual(created.data.workspacePath, folderPath);
      catalog.push({ id: "codex", label: "Codex", available: true, enabled: true, models: [{ id: "codex-fixture", label: "Codex Fixture", efforts: ["low", "high"], defaultEffort: "high", isDefault: true }] });
      const otherProvider = await request("threads", "POST", { projectId: folder.id, provider: "codex", workspace: { kind: "current" } });
      assert.equal(otherProvider.status, 200);
      assert.equal(otherProvider.data.model, "codex-fixture");
      assert.equal(otherProvider.data.effort, "high");
      await assert.rejects(callWorkspaceTool(created.data.id, "browser_tabs", {}), /Browser access is disabled/);
      await request(`projects?projectId=${folder.id}`, "PATCH", { settings: {
        provider: "claude", model: "fixture", effort: "high",
        permissionMode: "plan", workspace: "current", browserAccess: true,
      } });
      await assert.doesNotReject(callWorkspaceTool(created.data.id, "browser_tabs", {}));
      const overridden = await request("threads", "POST", { projectId: folder.id });
      assert.equal(overridden.data.effort, "high");
      assert.equal(overridden.data.permissionMode, "plan");
      assert.equal(overridden.data.workspacePath, folderPath);
      assert.equal(store.threads.get(created.data.id).permissionMode, "acceptEdits");
      store.configureNotifications({ sound: true });
      store.setComputerEnabled(true);
      store.setProviderEnabled("opencode", false);
      store.configureAssistance({ ...store.assistance, automaticTitles: false });
      assert.deepEqual(new Store().projectDefaults, defaults);
      assert.equal(new Store().projects.get(folder.id).settings.browserAccess, true);
      await request("projects/defaults", "PATCH", { settings: { ...defaults, permissionMode: "manual", effort: "high", browserAccess: true } });
      assert.equal(resolveProjectSettings(store.projectDefaults, folder.settings).permissionMode, "plan");
      await request(`projects?projectId=${folder.id}`, "PATCH", { settings: { provider: null, workspace: "current" } });
      const automatic = resolveProjectSettings(store.projectDefaults, folder.settings);
      assert.equal(automatic.provider, null);
      assert.equal(automatic.model, undefined);
      assert.equal(automatic.effort, undefined);
      assert.equal(automatic.permissionMode, "manual");
      catalog[0].models.push({ id: "other", label: "Other", efforts: ["low", "high"], defaultEffort: "low" });
      const explicit = await request("threads", "POST", { projectId: folder.id, provider: "claude", model: "other" });
      assert.equal(explicit.data.model, "other");
      assert.equal(explicit.data.effort, "low");
      await request(`projects?projectId=${folder.id}`, "PATCH", { settings: {} });
      const inherited = await request("threads", "POST", { projectId: folder.id });
      assert.equal(inherited.data.model, "fixture");
      assert.equal(inherited.data.effort, "high");
      assert.equal(inherited.data.permissionMode, "manual");
      assert.notEqual(inherited.data.workspacePath, folderPath);
      assert.deepEqual(new Store().projects.get(folder.id).settings, {});
      await assert.doesNotReject(callWorkspaceTool(created.data.id, "browser_tabs", {}));
      await request(`projects?projectId=${folder.id}`, "PATCH", { settings: { browserAccess: false } });
      await assert.rejects(callWorkspaceTool(created.data.id, "browser_tabs", {}), /Browser access is disabled/);
      for (const invalid of [{ provider: "unknown" }, { provider: null, model: "fixture" }, { browserAccess: "false" }, { permissionMode: "unknown" }, { workspace: "existing" }, []]) {
        const response = await request("projects/defaults", "PATCH", { settings: invalid });
        assert.equal(response.status, 400, JSON.stringify(invalid));
      }
      assert.equal(store.projectDefaults.provider, "claude");
      assert.equal(store.projectDefaults.effort, "high");
      const current = await request("threads", "POST", { projectId: folder.id, model: "other", workspace: { kind: "current" } });
      assert.equal(current.data.effort, "low");
      assert.equal(current.data.workspacePath, folderPath);
      await request("projects/defaults", "PATCH", { settings: { ...defaults, workspace: "current", autoPull: true } });
      fs.writeFileSync(join(repo, "global-pull.txt"), "inherited pull");
      git("add", "global-pull.txt");
      git("commit", "-m", "Global pull fixture");
      const pulled = await request("threads", "POST", { projectId: folder.id });
      assert.equal(pulled.status, 200, JSON.stringify(pulled.data));
      assert.equal(fs.readFileSync(join(folderPath, "global-pull.txt"), "utf8"), "inherited pull");
      await request(`projects?projectId=${folder.id}`, "PATCH", { settings: { autoPull: false } });
      fs.writeFileSync(join(repo, "global-pull.txt"), "folder pull disabled");
      git("add", "global-pull.txt");
      git("commit", "-m", "Folder pull fixture");
      const unchanged = await request("threads", "POST", { projectId: folder.id });
      assert.equal(unchanged.status, 200);
      assert.equal(fs.readFileSync(join(folderPath, "global-pull.txt"), "utf8"), "inherited pull");
    } finally {
      store.configureProjectDefaults({});
      store.setProviderEnabled("opencode", true);
      store.setComputerEnabled(false);
      store.configureNotifications({ sound: false });
    }
  });
  await t.test(
    "uploads preview, reach the provider, and cannot escape their conversation",
    async () => {
      const response = await fetch(
        `${url}attachments?threadId=${thread.id}&name=metadata.json`,
        { method: "POST", body: '{"attached":true}' },
      );
      assert.equal(response.status, 200);
      attachment = await response.json();
      const preview = await request(
        `preview?threadId=${thread.id}&attachmentId=${attachment.id}`,
      );
      assert.equal(preview.data.text, '{"attached":true}');
      assert.equal(preview.data.mime, "application/json");
      const different = store.createThread({
        projectId: project.id,
        provider: "claude",
        title: "Other",
        permissionMode: "manual",
      });
      assert.equal(
        (
          await request(
            `preview?threadId=${different.id}&attachmentId=${attachment.id}`,
          )
        ).status,
        400,
      );
      const parameters = `projectId=${project.id}&threadId=${thread.id}`;
      assert.equal(
        (await request(`preview?${parameters}&path=example.txt`)).data.text,
        "Separate checkout",
      );
      assert.equal(
        (
          await request(
            `preview?${parameters}&path=${encodeURIComponent(join(repo, "example.txt"))}`,
          )
        ).status,
        400,
      );
      fs.symlinkSync(
        join(repo, "example.txt"),
        join(thread.workspacePath, "escape"),
      );
      assert.equal(
        (await request(`preview?${parameters}&path=escape`)).status,
        400,
      );
      await runtimeFor(thread.id).send("Use @example with this file", [
        { ...attachment, path: "/etc/passwd" },
      ]);
      assert.equal(session.options.cwd, thread.workspacePath);
      assert.equal(session.sent[0][1][0].path, attachment.path);
      assert.equal(
        session.sent[0][2][0].path,
        join(thread.workspacePath, ".claude/skills/example/SKILL.md"),
      );
      assert.equal(
        (
          await request(
            `attachments?threadId=${thread.id}&id=${attachment.id}`,
            "DELETE",
          )
        ).status,
        400,
      );
      session.options.emit({ type: "turn.end" });
      store.flush();
      assert.equal(
        new Store().threads.get(thread.id).messages[0].attachments[0].id,
        attachment.id,
      );
      const range = await fetch(
        `${url}assets?threadId=${thread.id}&attachmentId=${attachment.id}`,
        { headers: { range: "bytes=0-3" } },
      );
      assert.equal(range.status, 206);
      assert.equal(await range.text(), '{"at');
      assert.equal(range.headers.get("x-content-type-options"), "nosniff");
      assert.match(range.headers.get("content-security-policy"), /sandbox/);
      assert.equal(
        (
          await fetch(url + "diagnostics", {
            headers: { Origin: "https://evil.invalid" },
          })
        ).status,
        403,
      );
      assert.equal(
        (await fetch(url + "diagnostics", { headers: { Origin: "null" } }))
          .status,
        403,
      );
    },
  );
  await t.test(
    "manual compaction keeps history and automatic compaction keeps running",
    async () => {
      const runtime = runtimeFor(thread.id);
      const count = thread.messages.length;
      assert.equal(
        (await request(`threads/compact?threadId=${thread.id}`, "POST")).status,
        200,
      );
      assert.equal(session.compacted, 1);
      assert.equal(thread.compacting, true);
      await assert.rejects(runtime.send("Too early"), /compaction/);
      session.options.emit({ type: "compacted", contextTokens: 40 });
      assert.equal(thread.running, false);
      assert.equal(thread.usage.contextTokens, 40);
      assert.equal(thread.messages.length, count + 1);
      assert.equal(thread.messages[0].attachments[0].id, attachment.id);
      await runtime.send("Next turn");
      session.options.emit({ type: "compacted", contextTokens: 20 });
      assert.equal(thread.running, true);
      session.options.emit({ type: "turn.end" });
    },
  );
  await t.test(
    "organization persists, wakes, and does not finish on selection",
    async () => {
      assert.equal(
        (
          await request(`threads/organize?threadId=${thread.id}`, "PATCH", {
            title: "Renamed",
            pinned: true,
            pullRequest: "https://github.com/example/project/pull/12",
          })
        ).status,
        200,
      );
      assert.equal(thread.finished, false);
      assert.equal(thread.pinned, true);
      assert.equal(
        (
          await request(`threads/organize?threadId=${thread.id}`, "PATCH", {
            archived: true,
          })
        ).status,
        200,
      );
      assert.equal(thread.finished, false);
      assert.equal(thread.archived, true);
      await request(`threads/organize?threadId=${thread.id}`, "PATCH", {
        archived: false,
        snoozedUntil: Date.now() + 60000,
      });
      assert.ok(thread.snoozedUntil);
      thread.snoozedUntil = Date.now() - 1;
      store.wakeThreads();
      assert.equal(thread.snoozedUntil, undefined);
      store.flush();
      assert.equal(
        new Store().threads.get(thread.id).pullRequest,
        thread.pullRequest,
      );
    },
  );
  await t.test(
    "skills can be disabled, restored, and deleted without changing live sessions",
    async () => {
      const skill = (await listSkills(project.id)).find(
        (entry) => entry.name === "example" && entry.provider === "claude",
      );
      store.patchThread(thread.id, { running: true });
      await assert.rejects(
        changeSkill(project.id, skill.id, "disable"),
        /finish/,
      );
      store.patchThread(thread.id, { running: false });
      await changeSkill(project.id, skill.id, "disable");
      assert.equal(
        (await listSkills(project.id)).find((entry) => entry.id === skill.id)
          .enabled,
        false,
      );
      await changeSkill(project.id, skill.id, "enable");
      assert.equal(fs.existsSync(skill.path), true);
      await changeSkill(project.id, skill.id, "delete");
      assert.equal(
        (await listSkills(project.id)).some((entry) => entry.id === skill.id),
        false,
      );
      assert.equal(
        fs.readdirSync(join(directory, ".citropy/deleted-skills")).length,
        1,
      );
    },
  );
  await t.test(
    "usage snapshots deduplicate message updates and clamp native allowance",
    () => {
      const usage = new MessageUsage({ input: 10 });
      usage.update("first", { input: 20, output: 3 });
      usage.update("first", { input: 20, output: 5 });
      usage.update("second", { input: 30, output: 2 });
      assert.equal(usage.totals.input, 60);
      assert.equal(usage.totals.output, 7);
      const codex = parseProviderLimits("codex", {
        rateLimitsByLimitId: {
          codex: {
            primary: {
              usedPercent: 110,
              windowDurationMins: 300,
              resetsAt: 200,
            },
          },
        },
      });
      assert.equal(codex.windows[0].usedPercent, 100);
      assert.equal(codex.windows[0].resetsAt, 200000);
      const claude = parseProviderLimits("claude", {
        rate_limits: {
          five_hour: { utilization: 25, resets_at: "2026-09-09T20:00:00Z" },
          model_scoped: [{ display_name: "Opus", utilization: 3 }],
        },
      });
      assert.equal(claude.windows.length, 2);
      const persistedPath = attachment.path;
      store.removeThread(thread.id);
      assert.equal(fs.existsSync(persistedPath), false);
      assert.throws(() => workspacePath(project.id, thread.id), /Conversation/);
    },
  );
});
