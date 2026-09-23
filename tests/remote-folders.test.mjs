import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chooseNativeFolder, listRemoteFolder } from "../desktop/folder-picker.mjs";

function hasKdialog() {
  try { execFileSync("sh", ["-c", "command -v kdialog"], { stdio: "ignore" }); return true; } catch { return false; }
}

test("SSH folders can be browsed without an SFTP system chooser", async t => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-remote-folders-"));
  const home = join(directory, "home");
  const bin = join(directory, "bin");
  const previous = { PATH: process.env.PATH, CITROPY_FAKE_HOME: process.env.CITROPY_FAKE_HOME };
  t.after(async () => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await rm(directory, { recursive: true, force: true }); });
  for (const name of ["projects", "projects/New folder", "projects/100% # ✓", "projects/it's here", "projects/.config", "projects/-dash", "zeta", "Alpha", "empty"])
    await mkdir(join(home, name), { recursive: true });
  await mkdir(bin);
  await writeFile(join(home, "projects", "notes.txt"), "not a folder");
  await symlink(join(home, "zeta"), join(home, "projects", "linked"));
  // Stands in for ssh: the final argument is the command string a remote login shell would run.
  await writeFile(join(bin, "ssh"), `#!/bin/sh\nfor last; do [ "$last" = -G ] && { printf 'user dev\\nhostname buildbox.local\\nport 2222\\n'; exit 0; }; done\nprintf 'motd noise\\n'\nHOME="$CITROPY_FAKE_HOME" exec /bin/sh -c "$last"\n`, { mode: 0o700 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.CITROPY_FAKE_HOME = home;
  const connection = { name: "Build server", target: "buildbox", port: 2222, node: "node" };
  const signal = new AbortController().signal;

  const root = await listRemoteFolder(connection, "", signal);
  assert.equal(root.path, home);
  assert.deepEqual(root.folders.map(folder => folder.name), ["Alpha", "empty", "projects", "zeta"]);
  assert.equal((await listRemoteFolder(connection, "~", signal)).path, home);

  const projects = await listRemoteFolder(connection, "~/projects", signal);
  assert.equal(projects.path, join(home, "projects"));
  assert.equal(projects.parent, home);
  assert.deepEqual(projects.folders, [
    { name: "-dash", hidden: false },
    { name: ".config", hidden: true },
    { name: "100% # ✓", hidden: false },
    { name: "it's here", hidden: false },
    { name: "linked", hidden: false },
    { name: "New folder", hidden: false },
  ]);
  assert.equal((await listRemoteFolder(connection, join(home, "projects", "it's here"), signal)).folders.length, 0);
  assert.equal((await listRemoteFolder(connection, "/", signal)).parent, null);

  const unusual = join(home, "unusual");
  const unusualNames = [" leading", "trailing ", "$(printf expanded)", "`printf expanded`", "; exit 9 #", "*[?]"];
  await mkdir(unusual);
  for (const name of unusualNames) await mkdir(join(unusual, name));
  assert.deepEqual(new Set((await listRemoteFolder(connection, unusual, signal)).folders.map(folder => folder.name)), new Set(unusualNames));
  for (const name of unusualNames) {
    const selected = await listRemoteFolder(connection, join(unusual, name), signal);
    assert.equal(selected.path, join(unusual, name));
    assert.equal(selected.parent, unusual);
    assert.deepEqual(selected.folders, []);
  }

  await assert.rejects(listRemoteFolder(connection, join(home, "missing"), signal), /does not exist/);
  await assert.rejects(listRemoteFolder(connection, join(home, "projects", "notes.txt"), signal), /does not exist/);
  for (const path of ["projects", "../etc", "/tmp\nx", "/tmp\rx", "/tmp\0x", "~other", `/${"x".repeat(4096)}`])
    await assert.rejects(listRemoteFolder(connection, path, signal), /absolute folder path/);

  if (process.platform !== "linux" || !hasKdialog()) {
    const showDialog = async () => { throw new Error("SSH folders must not use the local dialog"); };
    assert.deepEqual(await chooseNativeFolder({ connection, signal }, showDialog), { browse: true, path: "" });
    await assert.rejects(chooseNativeFolder({ connection, signal: AbortSignal.abort() }, showDialog), /abort/i);
  }
});
