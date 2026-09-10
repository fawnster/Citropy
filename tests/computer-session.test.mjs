import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import os from "node:os";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";

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
  class Desktop extends EventEmitter {
    OPEN = 1;
    readyState = 1;
    send(raw) {
      const { id, method, params } = JSON.parse(raw);
      calls.push({ method, params });
      const reply = () => {
        if (method === "computer.stop") this.emit("message", JSON.stringify({ t: "computer.stopped" }));
        const result = method === "computer.capabilities" ? { available: true, platform: "linux", backend: "x11" }
          : method === "computer.start" ? { displays: [{ id: "screen", name: "Monitor", width: 1920, height: 1080 }], shortcut: true }
          : method === "computer.screenshot" ? { image: "/9j/", width: 960, height: 540 }
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
    await computer.computerScreenshot(thread.id, undefined, 1600, true);
    await computer.pauseComputer(false);
    assert.throws(() => computer.computerAction(thread.id, { action: "click", frameId: frame.id, x: 1, y: 1 }), /screenshot/);
    await computer.stopComputer();
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
});
