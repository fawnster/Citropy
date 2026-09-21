import assert from "node:assert/strict";
import { test } from "node:test";
import { augmentPath } from "../server/paths.ts";
import { invocation, resolveCommand, resolveIn } from "../server/providers/binary.ts";

test("augmentPath prepends a missing well-known directory exactly once", () => {
  const env = { PATH: "/usr/bin:/bin" };
  const home = "/home/tester";
  const exists = (path) => path === "/home/tester/.local/bin";
  augmentPath(env, home, "linux", exists);
  assert.equal(env.PATH, "/home/tester/.local/bin:/usr/bin:/bin");
  augmentPath(env, home, "linux", exists);
  assert.equal(env.PATH, "/home/tester/.local/bin:/usr/bin:/bin");
});

test("resolveIn turns a Windows .ps1 launcher into a PowerShell invocation", () => {
  const resolved = resolveIn("cursor-agent", {
    platform: "win32",
    dirs: ["C:\\Users\\x\\AppData\\Local\\cursor-agent"],
    pathext: ".EXE;.CMD",
    exists: (path) => path.endsWith("agent.ps1"),
  });
  assert.equal(resolved.file, "powershell.exe");
  assert.ok(resolved.prefix.includes("-File"));
  assert.equal(resolved.prefix.at(-1), "C:\\Users\\x\\AppData\\Local\\cursor-agent\\cursor-agent.ps1");
  assert.equal(resolved.path, resolved.prefix.at(-1));
});

test("resolveIn routes a Windows .cmd shim through cmd.exe", () => {
  const resolved = resolveIn("foo", {
    platform: "win32",
    dirs: ["C:\\Tools"],
    pathext: ".EXE;.CMD",
    exists: (path) => path.toLowerCase().endsWith("foo.cmd"),
  });
  assert.equal(resolved.file, process.env.ComSpec ?? "cmd.exe");
  assert.equal(resolved.shell, "cmd");
  assert.equal(resolved.path, "C:\\Tools\\foo.CMD");
  const call = invocation(resolved, ["acp", "--flag", 'say "hi"']);
  assert.equal(call.verbatim, true);
  assert.deepEqual(call.args.slice(0, 3), ["/d", "/s", "/c"]);
  // One verbatim line: the launcher path plus each argument quoted and caret-escaped for cmd.exe.
  assert.equal(call.args[3], '"C:\\Tools\\foo.CMD ^"acp^" ^"--flag^" ^"say^ \\^"hi\\^"^""');
});

test("invocation with spaces in the launcher path escapes them for cmd.exe", () => {
  const resolved = resolveIn("bar", {
    platform: "win32",
    dirs: ["C:\\Program Files\\Bar"],
    pathext: ".CMD",
    exists: (path) => path.toLowerCase().endsWith("bar.cmd"),
  });
  const call = invocation(resolved, []);
  assert.equal(call.args[3], '"C:\\Program^ Files\\Bar\\bar.CMD"');
});

test("invocation passes direct executables and PowerShell launchers through untouched", () => {
  const direct = invocation({ file: "node", prefix: [] }, ["--version"]);
  assert.deepEqual(direct, { file: "node", args: ["--version"], verbatim: false });
  const ps = invocation({ file: "powershell.exe", prefix: ["-File", "C:\\x\\agent.ps1"] }, ["acp"]);
  assert.deepEqual(ps.args, ["-File", "C:\\x\\agent.ps1", "acp"]);
  assert.equal(ps.verbatim, false);
});

test("resolveCommand finds node on this machine", () => {
  const resolved = resolveCommand("node");
  assert.equal(resolved.file, "node");
  assert.ok(resolved.path);
});
