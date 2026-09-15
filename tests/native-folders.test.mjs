import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chooseNativeFolder, remoteFolderLocation, remoteFolderPath } from "../desktop/folder-picker.mjs";

test("native SSH folder selections preserve names and reject folders from other hosts", () => {
  const location = { url: "sftp://dev@buildbox:2222/home/dev/", hostname: "buildbox.local" };
  assert.equal(remoteFolderPath("sftp://dev@buildbox:2222/home/dev/New%20folder/100%25%20%23%20%E2%9C%93", location), "/home/dev/New folder/100% # ✓");
  assert.equal(remoteFolderPath("sftp://dev@buildbox.local:2222/projects/", location), "/projects/");
  assert.equal(remoteFolderPath("sftp://dev@BUILDBOX:2222/projects/", location), "/projects/");
  assert.equal(remoteFolderPath("sftp://dev@[::1]:2222/projects/", { ...location, hostname: "::1" }), "/projects/");
  for (const value of ["/home/dev", "file:///home/dev", "sftp://dev@another:2222/home/dev", "sftp://other@buildbox:2222/home/dev", "sftp://dev@buildbox/home/dev", "sftp://dev:password@buildbox:2222/home/dev", "sftp://dev@buildbox:2222/a%00b"])
    assert.throws(() => remoteFolderPath(value, location));
});

test("the desktop uses the system dialog for local and SSH folders, including cancellation", async t => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-native-folders-"));
  const bin = join(directory, "bin");
  const local = join(directory, "Local workspace");
  await Promise.all([mkdir(bin), mkdir(local)]);
  const previous = { PATH: process.env.PATH, CITROPY_PICKER_RESULT: process.env.CITROPY_PICKER_RESULT, CITROPY_PICKER_ARGS: process.env.CITROPY_PICKER_ARGS };
  t.after(async () => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await rm(directory, { recursive: true, force: true }); });
  await writeFile(join(bin, "ssh"), `#!${process.execPath}\nif(process.argv.includes('-G'))console.log('user dev\\nhostname buildbox.local\\nport 2222');else console.log('CITROPY_HOME /home/dev');\n`, { mode: 0o700 });
  await writeFile(join(bin, "kdialog"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.CITROPY_PICKER_ARGS,JSON.stringify(process.argv.slice(2)));if(process.env.CITROPY_PICKER_RESULT==='cancel')process.exit(1);console.log(process.env.CITROPY_PICKER_RESULT);\n`, { mode: 0o700 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.CITROPY_PICKER_ARGS = join(directory, "args.json");
  process.env.CITROPY_PICKER_RESULT = local;
  const showDialog = async () => { throw new Error("The installed system chooser should be used"); };
  const signal = new AbortController().signal;
  assert.equal(await chooseNativeFolder({ signal }, showDialog), local);
  const connection = { name: "Build server", target: "buildbox", port: 2222, node: "node" };
  const location = await remoteFolderLocation(connection, "/home/dev/100% # ✓", signal);
  assert.equal(remoteFolderPath(location.url, location), "/home/dev/100% # ✓/");
  process.env.CITROPY_PICKER_RESULT = "sftp://dev@buildbox:2222/home/dev/New%20folder";
  assert.equal(await chooseNativeFolder({ connection, signal }, showDialog), "/home/dev/New folder");
  assert.deepEqual(JSON.parse(await readFile(process.env.CITROPY_PICKER_ARGS, "utf8")), ["--getexistingdirectory", "sftp://dev@buildbox:2222/home/dev/", "--title", "Open workspace on Build server"]);
  process.env.CITROPY_PICKER_RESULT = "cancel";
  assert.equal(await chooseNativeFolder({ connection, signal }, showDialog), null);
  process.env.CITROPY_PICKER_RESULT = local;
  await assert.rejects(chooseNativeFolder({ connection, signal }, showDialog), /selected SSH host/);
  await assert.rejects(chooseNativeFolder({ connection, signal: AbortSignal.abort() }, showDialog), /abort/i);
});
