import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { tmpdir } from "node:os";

const swift = process.platform === "darwin" && (() => { try { execFileSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" }); return true; } catch { return false; } })();

function session(t, helper) {
  const child = spawn(helper, [], { stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  const events = [];
  let id = 0;
  createInterface({ input: child.stdout }).on("line", line => {
    const message = JSON.parse(line);
    if (message.event) events.push(message);
    else if (waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
    else waiting.get("raw")?.(message);
  });
  const request = (method, params = {}) => new Promise(resolve => {
    const requestId = ++id;
    waiting.set(requestId, resolve);
    child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
  });
  const raw = line => new Promise(resolve => { waiting.set("raw", resolve); child.stdin.write(`${line}\n`); });
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
    try { await exited; } finally { clearTimeout(timer); }
  });
  return { child, request, raw, events, exited };
}

test("the macOS computer helper builds, probes permissions and speaks the helper protocol", { skip: !swift && "requires macOS with the Xcode Swift compiler", timeout: 300_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-computer-mac-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { buildComputerHelper } = await import("../desktop/computer-mac-build.mjs");
  const helper = await buildComputerHelper({ output: join(directory, "computer-mac") });

  const probe = JSON.parse(execFileSync(helper, ["--probe"], { encoding: "utf8" }));
  assert.equal(probe.platform, "darwin");
  assert.equal(typeof probe.available, "boolean");
  if (probe.available) {
    assert.equal(probe.backend, "macos");
    assert.equal(typeof probe.screenRecording, "boolean");
    assert.equal(typeof probe.accessibility, "boolean");
    assert.equal(Boolean(probe.reason), !(probe.screenRecording && probe.accessibility));
  }

  const idle = session(t, helper);
  assert.equal((await idle.request("screenshot", { displayId: "1" })).error, "Start a computer session first.");
  assert.equal((await idle.request("action", { action: "move" })).error, "Start a computer session first.");
  const malformed = await idle.raw("{not json");
  assert.equal(malformed.id, null);
  assert.ok(malformed.error);
  idle.child.stdin.end();
  assert.deepEqual(await idle.exited, { code: 0, signal: null });

  for (const signal of ["SIGTERM", "SIGINT"]) {
    const interrupted = session(t, helper);
    assert.equal((await interrupted.request("action", { action: "wait" })).error, "Start a computer session first.");
    interrupted.child.kill(signal);
    assert.deepEqual(await interrupted.exited, { code: 0, signal: null });
  }

  // Capturing only runs where Screen Recording is already granted, so the test never prompts.
  if (!probe.available || !probe.screenRecording) return;
  const view = session(t, helper);
  const started = await view.request("start", { control: false });
  assert.equal(started.result.backend, "macos");
  assert.ok(started.result.displays.length > 0);
  const [display] = started.result.displays;
  for (const key of ["width", "height", "x", "y"]) assert.ok(Number.isInteger(display[key]), key);
  assert.equal((await view.request("start", { control: false })).error, "A computer session is already open.");

  const full = (await view.request("screenshot", { displayId: display.id, maxWidth: 640 })).result;
  assert.ok(full.image.startsWith("/9j/"), "JPEG image");
  assert.ok(full.width <= 640 && full.height <= 1600);
  assert.equal(full.crop, undefined);
  const close = (await view.request("screenshot", { displayId: display.id, maxWidth: 2560, crop: { x: 0.5, y: 0.5, width: 0.25, height: 0.25 } })).result;
  assert.equal(close.crop.x, 0.5);
  assert.ok(Math.abs(close.crop.width - 0.25) < 0.01);
  assert.ok(close.width > full.width / 4);

  assert.equal((await view.request("screenshot", { displayId: "missing" })).error, "Choose one of the shared screens.");
  assert.equal((await view.request("screenshot", { displayId: display.id, maxWidth: 100 })).error, "Invalid image width");
  assert.equal((await view.request("screenshot", { displayId: display.id, crop: { x: 0.9, y: 0, width: 0.5, height: 0.5 } })).error, "The region must fit inside the screen.");
  assert.equal((await view.request("action", { action: "move", displayId: display.id, x: 1, y: 1 })).error, "This session only allows viewing the screen.");
  assert.deepEqual((await view.request("pause", { paused: true })).result, { paused: true });
  assert.equal((await view.request("action", { action: "wait" })).error, "Computer control is paused.");
  view.child.kill("SIGTERM");
  assert.deepEqual(await view.exited, { code: 0, signal: null });
});
