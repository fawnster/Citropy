import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import os from "node:os";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { writeFile, rename, rm } from "node:fs/promises";

async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Expected session state did not arrive");
}

test("computer sessions enforce ownership, consent, coordinates and cleanup", { timeout: 20000 }, async t => {
  const directory = mkdtempSync(join(os.tmpdir(), "citropy-computer-session-"));
  const originalHome = os.homedir;
  os.homedir = () => directory;
  syncBuiltinESMExports();
  const { store, Store } = await import("../server/store.ts");
  const { bus } = await import("../server/bus.ts");
  const { attachDesktop } = await import("../server/desktop.ts");
  const computer = await import("../server/computer.ts");
  const { pendingRequests, answer } = await import("../server/permissions.ts");
  const { callWorkspaceTool, handleMcp } = await import("../server/mcp.ts");
  const { connectTools } = await import("../server/mcp-access.ts");
  const { handleFeatures } = await import("../server/features.ts");
  const { installComputerSkill } = await import("../server/builtin-skills.ts");
  const { listSkills, changeSkill, readSkill } = await import("../server/skills.ts");
  const calls = [];
  let delayStart = false;
  let failPause = false;
  let displays = [{ id: "screen", name: "Monitor", width: 1920, height: 1080 }];
  let screenshot = { image: "/9j/", width: 960, height: 540 };
  class Desktop extends EventEmitter {
    OPEN = 1;
    readyState = 1;
    send(raw) {
      const { id, method, params } = JSON.parse(raw);
      calls.push({ method, params });
      const reply = () => {
        if (method === "computer.stop") this.emit("message", JSON.stringify({ t: "computer.stopped" }));
        const result = method === "computer.capabilities" ? { available: true, platform: "linux", backend: "x11" }
          : method === "computer.start" ? { displays, shortcut: true }
          : method === "computer.screenshot" ? screenshot
          : {};
        this.emit("message", JSON.stringify({ id, ...(method === "computer.pause" && failPause ? { error: "Disconnected while pausing" } : { result }) }));
      };
      setTimeout(reply, method === "computer.start" && delayStart ? 50 : 0);
    }
    close() { this.readyState = 3; this.emit("close"); }
  }
  let desktop = new Desktop();
  attachDesktop(desktop);
  mkdirSync(join(directory, "workspace"));
  const project = store.openProject(join(directory, "workspace"));
  const makeThread = permissionMode => store.createThread({ projectId: project.id, provider: "claude", model: "test", title: "Computer test", permissionMode });
  const thread = makeThread("bypass");
  const other = makeThread("bypass");
  const manual = makeThread("manual");
  const plan = makeThread("plan");
  const server = createServer((req, res) => {
    if (req.url.startsWith("/mcp/")) void handleMcp(req.url.split("/")[2], req, res);
    else void handleFeatures(req, res, []);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await computer.stopComputer(); desktop.close(); store.flush();
    await new Promise(resolve => server.close(resolve));
    os.homedir = originalHome; syncBuiltinESMExports();
    rmSync(directory, { recursive: true, force: true });
  });

  await t.test("disabled by default, persistent opt-in and authenticated access", async () => {
    assert.equal(computer.computerState().enabled, false);
    await assert.rejects(computer.startComputer(thread.id), /Enable computer use/);
    const crossOrigin = await fetch(`${url}/api/computer`, { method: "PATCH", headers: { origin: "https://example.com", "content-type": "application/json" }, body: '{"enabled":true}' });
    assert.equal(crossOrigin.status, 403);
    const unauthorized = await fetch(`${url}/mcp/${thread.id}`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "computer_start" } }) });
    assert.equal(unauthorized.status, 401);
    await computer.configureComputer(true);
    store.configureNotifications({ sound: true });
    store.setProviderEnabled("opencode", false);
    const saved = new Store();
    assert.equal(saved.computerEnabled, true);
    assert.equal(saved.notificationPreferences.sound, true);
    assert.ok(saved.disabledProviders.has("opencode"));
    await computer.startComputer(thread.id);
    await assert.rejects(computer.startComputer(other.id), /already open/);
    await assert.rejects(callWorkspaceTool(other.id, "computer_screenshot", {}), /does not own/);
    await assert.rejects(callWorkspaceTool(other.id, "computer_stop", {}), /does not own/);
    const auth = connectTools(thread.id);
    const response = await fetch(`${url}/mcp/${thread.id}`, { method: "POST", headers: auth.headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "computer_screenshot", arguments: {} } }) });
    const result = (await response.json()).result;
    assert.equal(result.content[1].type, "image");
    assert.equal(result.content[1].mimeType, "image/jpeg");
  });

  await t.test("scaled screenshots, validation and bounded activity", async () => {
    const frame = await computer.computerScreenshot(thread.id);
    await computer.computerAction(thread.id, { action: "click", frameId: frame.id, x: 100, y: 120 });
    assert.deepEqual(calls.at(-1), { method: "computer.action", params: { action: "click", displayId: "screen", x: 200, y: 240, button: "left", count: 1 } });
    assert.throws(() => computer.computerAction(thread.id, { action: "click", frameId: frame.id, x: 960, y: 1 }), /coordinate/);
    assert.throws(() => computer.computerAction(thread.id, { action: "click", frameId: "unknown", x: 1, y: 1 }), /screenshot/);
    assert.throws(() => computer.computerAction(thread.id, { action: "type", text: "bad\u0000text" }), /control codes/);
    for (let i = 0; i < 65; i++) await computer.computerAction(thread.id, { action: "type", text: "private text" });
    assert.equal(computer.computerState().activity.length, 60);
    assert.equal(JSON.stringify(computer.computerState()).includes("private text"), false);
    await computer.pauseComputer(true);
    assert.throws(() => computer.computerAction(thread.id, { action: "press", key: "Enter" }), /paused/);
    await computer.computerScreenshot(thread.id, { preview: true });
    await computer.pauseComputer(false);
    assert.throws(() => computer.computerAction(thread.id, { action: "click", frameId: frame.id, x: 1, y: 1 }), /screenshot/);
    await computer.stopComputer();
  });

  await t.test("Claude capture dimensions survive client resizing and restarted screens reject old IDs", async () => {
    const previousDisplays = displays;
    displays = [{ id: "103", name: "Screen 1", width: 2560, height: 1440 }, { id: "121", name: "Screen 2", width: 1920, height: 1080 }];
    screenshot = { image: "/9j/", width: 2000, height: 1125 };
    try {
      const first = await computer.startComputer(thread.id);
      const frame = await computer.computerScreenshot(thread.id, { displayId: first.displays[0].id, maxWidth: 2560 });
      assert.deepEqual(calls.at(-1), { method: "computer.screenshot", params: { displayId: "103", maxWidth: 2000 } });
      assert.deepEqual([frame.width, frame.height, frame.sourceWidth, frame.sourceHeight], [2000, 1125, 2560, 1440]);
      await computer.computerAction(thread.id, { action: "click", frameId: frame.id, x: 578, y: 17 });
      assert.ok(Math.abs(calls.at(-1).params.x - 739.84) < 1e-8);
      assert.ok(Math.abs(calls.at(-1).params.y - 21.76) < 1e-8);
      screenshot = { image: "/9j/", width: 2560, height: 1440 };
      const preview = await computer.computerScreenshot(thread.id, { maxWidth: 2560, preview: true });
      assert.equal(calls.at(-1).params.maxWidth, 2560);
      assert.equal(preview.width, 2560);
      await computer.stopComputer();
      assert.throws(() => computer.computerAction(thread.id, { action: "move", frameId: frame.id, x: 10, y: 10 }), /no active computer session/);
      displays = [{ ...displays[0], id: "121" }, { ...displays[1], id: "103" }];
      const second = await computer.startComputer(thread.id);
      assert.ok(second.displays.every(display => !first.displays.some(old => old.id === display.id)));
      const before = calls.length;
      await assert.rejects(computer.computerScreenshot(thread.id, { displayId: first.displays[0].id }), /current displayId/);
      assert.throws(() => computer.computerAction(thread.id, { action: "click", frameId: frame.id, x: 10, y: 10 }), /new computer screenshot/);
      assert.equal(calls.length, before);
      screenshot = { image: "/9j/", width: 2000, height: 1125 };
      await computer.computerScreenshot(thread.id, { displayId: second.displays[0].id, maxWidth: 2560 });
      assert.equal(calls.at(-1).params.displayId, "121");
    } finally {
      await computer.stopComputer();
      displays = previousDisplays;
      screenshot = { image: "/9j/", width: 960, height: 540 };
    }
  });

  await t.test("close-up screenshots map clicks, drags and nested regions back to the shared screen", async () => {
    await computer.startComputer(thread.id);
    try {
      const full = await computer.computerScreenshot(thread.id);
      screenshot = { image: "/9j/", width: 960, height: 540, crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } };
      const response = await callWorkspaceTool(thread.id, "computer_screenshot", { region: { frameId: full.id, x: 240, y: 135, width: 480, height: 270 } });
      const cropped = JSON.parse(response[0].text);
      assert.equal(response[1].type, "image");
      assert.deepEqual(calls.at(-1).params.crop, screenshot.crop);
      assert.deepEqual([cropped.sourceX, cropped.sourceY, cropped.sourceWidth, cropped.sourceHeight], [480, 270, 960, 540]);
      await computer.computerAction(thread.id, { action: "click", frameId: cropped.id, x: 100, y: 50 });
      assert.deepEqual(calls.at(-1).params, { action: "click", displayId: "screen", x: 580, y: 320, button: "left", count: 1 });
      await computer.computerAction(thread.id, { action: "drag", frameId: cropped.id, x: 10, y: 20, toX: 900, toY: 500 });
      assert.deepEqual(calls.at(-1).params, { action: "drag", displayId: "screen", x: 490, y: 290, toX: 1380, toY: 770, durationMs: 500 });
      screenshot = { image: "/9j/", width: 480, height: 270, crop: { x: 0.25, y: 0.25, width: 0.25, height: 0.25 } };
      const nested = await computer.computerScreenshot(thread.id, { region: { frameId: cropped.id, x: 0, y: 0, width: 480, height: 270 } });
      assert.deepEqual(calls.at(-1).params.crop, screenshot.crop);
      assert.deepEqual([nested.sourceX, nested.sourceY, nested.sourceWidth, nested.sourceHeight], [480, 270, 480, 270]);
      const before = calls.length;
      for (const region of [null, {}, { frameId: "old", x: 0, y: 0, width: 10, height: 10 }, { frameId: full.id, x: -1, y: 0, width: 10, height: 10 }, { frameId: full.id, x: 950, y: 0, width: 20, height: 10 }, { frameId: full.id, x: 0, y: 0, width: 0, height: 10 }]) {
        await assert.rejects(computer.computerScreenshot(thread.id, { region }), /screenshot|region/);
      }
      assert.equal(calls.length, before);
    } finally {
      await computer.stopComputer();
      screenshot = { image: "/9j/", width: 960, height: 540 };
    }
  });

  await t.test("approval gates input and pause cancels queued work", async () => {
    const start = computer.startComputer(manual.id);
    await until(() => pendingRequests().length === 1);
    assert.equal(computer.computerState().status, "starting");
    answer(pendingRequests()[0].id, "allow");
    await start;
    const frame = await computer.computerScreenshot(manual.id);
    const before = calls.filter(call => call.method === "computer.action").length;
    const action = computer.computerAction(manual.id, { action: "click", frameId: frame.id, x: 10, y: 10 }).catch(error => error.message);
    const queued = computer.computerAction(manual.id, { action: "type", text: "queued" }).catch(error => error.message);
    await until(() => pendingRequests().length === 1);
    await computer.pauseComputer(true);
    assert.match(await action, /Denied|paused/);
    assert.match(await queued, /paused/);
    assert.equal(pendingRequests().length, 0);
    assert.equal(calls.filter(call => call.method === "computer.action").length, before);
    await computer.stopComputer();
    const cancelled = computer.startComputer(manual.id).catch(error => error.message);
    await until(() => pendingRequests().length === 1);
    await computer.stopComputer();
    assert.match(await cancelled, /approved|stopped/);
    assert.equal(pendingRequests().length, 0);
  });

  await t.test("plan mode, session races and fail-closed pause", async () => {
    await computer.startComputer(plan.id, true);
    assert.equal(calls.findLast(call => call.method === "computer.start").params.control, false);
    assert.throws(() => computer.computerAction(plan.id, { action: "press", key: "Enter" }), /view only/);
    await computer.stopComputer();
    delayStart = true;
    const starting = computer.startComputer(thread.id).catch(error => error.message);
    await until(() => computer.computerState().status === "starting");
    await computer.stopComputer();
    assert.match(await starting, /stopped/);
    delayStart = false;
    await computer.startComputer(thread.id);
    failPause = true;
    await assert.rejects(computer.pauseComputer(true), /Disconnected/);
    failPause = false;
    assert.equal(computer.computerState().status, "idle");
  });

  await t.test("finish, disable and desktop closure release the session", async () => {
    await computer.startComputer(thread.id);
    bus.emit({ t: "thread.upsert", thread: { ...thread, finished: true } });
    await until(() => computer.computerState().status === "idle");
    await computer.startComputer(thread.id);
    await computer.configureComputer(false);
    assert.equal(computer.computerState().status, "idle");
    await computer.configureComputer(true);
    await computer.startComputer(thread.id);
    desktop.close();
    assert.equal(computer.computerState().status, "idle");
    desktop = new Desktop(); attachDesktop(desktop);
  });

  await t.test("bundled skill is shared, manageable and restorable", async () => {
    await installComputerSkill();
    const skills = (await listSkills()).filter(skill => skill.scope === "builtin");
    assert.deepEqual(skills.map(skill => skill.provider).sort(), ["claude", "codex", "opencode"]);
    assert.ok((await readSkill(undefined, skills[0].id)).includes("computer_screenshot"));
    await changeSkill(undefined, skills[0].id, "disable");
    assert.equal((await listSkills()).filter(skill => skill.scope === "builtin").every(skill => !skill.enabled), true);
    const restored = await fetch(`${url}/api/computer/skill`, { method: "POST" });
    assert.equal(restored.status, 200);
    assert.equal((await listSkills()).filter(skill => skill.scope === "builtin").every(skill => skill.enabled), true);
    assert.ok(readFileSync(join(directory, ".citropy/skills/computer-use/SKILL.md"), "utf8").includes("computer_stop"));
    assert.throws(() => readFileSync(join(directory, ".citropy/skills/computer-use/SKILL.md.citropy-disabled")));
  });

  await t.test("built-in skill updates preserve disabled, deleted and customized copies", async () => {
    const folder = join(directory, ".citropy/skills/computer-use");
    const enabled = join(folder, "SKILL.md");
    const disabled = join(folder, "SKILL.md.citropy-disabled");
    const marker = join(folder, ".installed");
    const current = readFileSync(enabled, "utf8");
    const previous = "Earlier built-in instructions";
    const fingerprint = createHash("sha256").update(previous).digest("hex");
    await writeFile(enabled, previous);
    await writeFile(marker, fingerprint);
    await installComputerSkill();
    assert.equal(readFileSync(enabled, "utf8"), current);
    await rename(enabled, disabled);
    await writeFile(disabled, previous);
    await writeFile(marker, fingerprint);
    await installComputerSkill();
    assert.equal(readFileSync(disabled, "utf8"), current);
    assert.throws(() => readFileSync(enabled));
    await writeFile(disabled, "My customized instructions");
    await installComputerSkill();
    assert.equal(readFileSync(disabled, "utf8"), "My customized instructions");
    await rm(disabled);
    await installComputerSkill();
    assert.throws(() => readFileSync(enabled));
    assert.throws(() => readFileSync(disabled));
  });
});
