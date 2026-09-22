import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopDiagnostics } from "../desktop/diagnostics.mjs";

test("desktop diagnostics persist only lifecycle metadata with private permissions", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "citropy-diagnostics-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "desktop.log");
  const diagnose = desktopDiagnostics(directory);
  diagnose("backend.exited", { childPid: 123, code: null, signal: "SIGBUS", stderr: "private prompt", url: "https://secret.test/?token=secret", token: "secret" });
  const entry = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(entry).sort(), ["childPid", "code", "event", "pid", "signal", "time"]);
  assert.equal(entry.childPid, 123);
  assert.equal(entry.code, null);
  assert.equal(entry.signal, "SIGBUS");
  assert.equal(entry.pid, process.pid);
  assert.ok(Number.isFinite(Date.parse(entry.time)));
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("desktop diagnostics keep one bounded previous log", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "citropy-diagnostics-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "desktop.log");
  const diagnose = desktopDiagnostics(directory);
  writeFileSync(file, "a".repeat(128 * 1024), { mode: 0o644 });
  diagnose("app.started");
  assert.equal(statSync(`${file}.1`).size, 128 * 1024);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).event, "app.started");
  if (process.platform !== "win32") assert.equal(statSync(`${file}.1`).mode & 0o777, 0o600);
  writeFileSync(file, "b".repeat(128 * 1024));
  diagnose("app.exited", { code: 0 });
  assert.equal(readFileSync(`${file}.1`, "utf8"), "b".repeat(128 * 1024));
  assert.equal(JSON.parse(readFileSync(file, "utf8")).event, "app.exited");
  assert.deepEqual(readdirSync(directory).sort(), ["desktop.log", "desktop.log.1"]);
});

test("unavailable diagnostics storage never interrupts the app", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "citropy-diagnostics-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "not-a-directory");
  writeFileSync(file, "preserve");
  assert.doesNotThrow(() => desktopDiagnostics(file)("app.started"));
  assert.equal(readFileSync(file, "utf8"), "preserve");
});
