import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";

test("provider command discovery uses workspace configuration and personal Codex prompts expand safely", async (t) => {
  const directory = fs.mkdtempSync(join(os.tmpdir(), "citropy-commands-"));
  const originalSpawn = childProcess.spawn;
  const originalHome = os.homedir;
  const codexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(directory, ".codex");
  os.homedir = () => directory;
  const invocations = [];
  childProcess.spawn = (binary, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      child.stopped = true;
      queueMicrotask(() => child.emit("close", 0));
      return true;
    };
    child.stdin.on("data", (data) => {
      const request = JSON.parse(data);
      queueMicrotask(() =>
        child.stdout.write(
          JSON.stringify({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: request.request_id,
              response: {
                commands: [
                  { name: "context", description: "Context report" },
                  {
                    name: "project-check",
                    description: "Workspace command",
                    argumentHint: "[files]",
                  },
                  { name: "old", description: "(removed) Old command" },
                ],
              },
            },
          }) + "\n",
        ),
      );
    });
    invocations.push({ binary, args, options, child });
    return child;
  };
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.spawn = originalSpawn;
    os.homedir = originalHome;
    if (codexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = codexHome;
    syncBuiltinESMExports();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const { listCommands, expandCommand } = await import("../server/commands.ts");
  const commands = await listCommands("claude", directory);
  assert.deepEqual(
    commands.map((command) => command.name),
    ["context", "project-check"],
  );
  assert.equal(invocations[0].options.cwd, directory);
  assert.equal(invocations[0].child.stopped, true);
  assert.deepEqual(await listCommands("claude", directory), commands);
  assert.equal(invocations.length, 1);
  fs.mkdirSync(join(process.env.CODEX_HOME, "prompts"), { recursive: true });
  fs.writeFileSync(
    join(process.env.CODEX_HOME, "prompts/explain.md"),
    "---\ndescription: Explain a file\nargument-hint: FILE=path\n---\nRead $FILE. Request: $ARGUMENTS",
  );
  const codex = await listCommands("codex", directory);
  assert.deepEqual(
    codex.map((command) => command.name),
    ["review", "prompts:explain"],
  );
  assert.equal(codex[1].template, undefined);
  assert.equal(
    await expandCommand("codex", '/prompts:explain FILE="two words.ts"'),
    'Read two words.ts. Request: FILE="two words.ts"',
  );
  await assert.rejects(
    expandCommand("codex", "/prompts:explain"),
    /Provide FILE/,
  );
  await assert.rejects(
    expandCommand("codex", "/prompts:missing"),
    /no longer installed/,
  );
  assert.equal(await expandCommand("claude", "/context"), "/context");
});
