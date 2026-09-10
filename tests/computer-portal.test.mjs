import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("Wayland portal grants, screenshots, input and session cleanup", { timeout: 25000 }, async () => {
  await promisify(execFile)("dbus-run-session", ["--", "python3", "-B", fileURLToPath(new URL("./fixtures/computer-portal.py", import.meta.url))], { timeout: 20000 });
});
