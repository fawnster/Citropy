import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("macOS helper builds remove stale output and intermediate files after failures", async t => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-computer-build-"));
  const output = join(directory, "computer-mac");
  const execFile = childProcess.execFile;
  let failure;
  const targets = [];
  childProcess.execFile = (command, args, options, callback) => {
    callback ??= options;
    Promise.resolve().then(async () => {
      if (command === "xcrun") {
        const target = args[args.indexOf("-target") + 1];
        targets.push(target);
        await writeFile(args[args.indexOf("-o") + 1], target);
        if (failure === "compile" && target.startsWith("x86_64")) throw new Error("compile failed");
      } else if (command === "lipo") {
        const slices = await Promise.all(args.slice(1, -2).map(path => readFile(path, "utf8")));
        await writeFile(args.at(-1), slices.join("\n"));
        if (failure === "link") throw new Error("link failed");
      } else if (command === "codesign") {
        if (failure === "sign") throw new Error("sign failed");
        await writeFile(args.at(-1), "signed helper");
      } else {
        throw new Error(`Unexpected command: ${command}`);
      }
    }).then(() => callback(null, "", ""), error => callback(error));
  };
  syncBuiltinESMExports();
  t.after(async () => {
    childProcess.execFile = execFile;
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  });
  const { buildComputerHelper } = await import("../desktop/computer-mac-build.mjs");

  for (const stage of ["compile", "link", "sign"]) {
    await t.test(`${stage} failure removes the old helper and partial artifacts`, async () => {
      failure = stage;
      await writeFile(output, "old helper");
      await assert.rejects(buildComputerHelper({ output, architectures: ["arm64", "x86_64"] }), new RegExp(`${stage} failed`));
      assert.deepEqual(await readdir(directory), []);
    });
  }

  await t.test("successful universal build keeps only the signed output", async () => {
    failure = undefined;
    targets.length = 0;
    assert.equal(await buildComputerHelper({ output, architectures: ["arm64", "x86_64"] }), output);
    assert.deepEqual(targets, ["arm64-apple-macos12.0", "x86_64-apple-macos12.0"]);
    assert.equal(await readFile(output, "utf8"), "signed helper");
    assert.deepEqual(await readdir(directory), ["computer-mac"]);
  });
});
