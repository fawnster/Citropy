import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";

test("Codex skills use native discovery and enable settings instead of stale plugin caches", async (t) => {
  const directory = fs.mkdtempSync(join(os.tmpdir(), "citropy-skills-"));
  const home = os.homedir;
  const spawn = childProcess.spawn;
  const env = {
    CODEX_HOME: process.env.CODEX_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  os.homedir = () => directory;
  process.env.CODEX_HOME = join(directory, ".codex");
  process.env.CLAUDE_CONFIG_DIR = join(directory, ".claude");
  process.env.XDG_CONFIG_HOME = join(directory, ".config");
  const path = join(directory, ".codex/skills/review/SKILL.md");
  const stale = join(
    directory,
    ".codex/plugins/cache/stale/old/skills/review/SKILL.md",
  );
  for (const file of [path, stale]) {
    fs.mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(
      file,
      "---\nname: review\ndescription: Review fixture changes.\n---\nRead the files.",
    );
  }
  let enabled = false;
  const writes = [];
  const processes = [];
  childProcess.spawn = (binary) => {
    assert.equal(binary, "codex");
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = () => {
      queueMicrotask(() => child.emit("exit", 0));
      return true;
    };
    child.stdin.on("data", (raw) => {
      const message = JSON.parse(raw);
      if (message.id === undefined) return;
      let result = {};
      if (message.method === "skills/list")
        result = {
          data: [
            {
              cwd: directory,
              skills: [
                {
                  name: "review",
                  description: "Review fixture changes.",
                  path,
                  enabled,
                  scope: "user",
                },
              ],
              errors: [],
            },
          ],
        };
      if (message.method === "skills/config/write") {
        writes.push(message.params);
        enabled = message.params.enabled;
      }
      queueMicrotask(() =>
        child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`),
      );
    });
    processes.push(child);
    return child;
  };
  syncBuiltinESMExports();
  t.after(() => {
    os.homedir = home;
    childProcess.spawn = spawn;
    for (const [key, value] of Object.entries(env))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    syncBuiltinESMExports();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const { listSkills, changeSkill } = await import("../server/skills.ts");
  const inventory = await listSkills();
  assert.deepEqual(inventory.filter(skill => skill.scope === "builtin").map(skill => skill.provider).sort(), ["claude", "codex", "opencode"]);
  const skills = inventory.filter(skill => skill.scope !== "builtin");
  assert.equal(skills.length, 1);
  assert.equal(skills[0].enabled, false);
  assert.equal(skills[0].providerManaged, true);
  await changeSkill(undefined, skills[0].id, "enable");
  assert.deepEqual(writes[0], { path, enabled: true });
  assert.equal(fs.existsSync(path), true);
  assert.equal((await listSkills()).find(skill => skill.id === skills[0].id).enabled, true);
  await changeSkill(undefined, skills[0].id, "disable");
  assert.deepEqual(writes[1], { path, enabled: false });
  assert.equal(fs.existsSync(path), true);
  await changeSkill(undefined, skills[0].id, "delete");
  assert.equal(fs.existsSync(path), false);
  assert.equal(fs.existsSync(stale), true);
});
