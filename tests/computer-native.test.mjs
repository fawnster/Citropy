import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);

test("native computer capture, input and cancellation on an isolated desktop", { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-computer-native-"));
  const display = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1200x800x24"], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
  let target, browser;
  const pending = new Map();
  t.after(async () => {
    target?.stdin.end();
    if (target && target.exitCode === null && target.signalCode === null) {
      const timer = setTimeout(() => target.kill("SIGKILL"), 3000);
      try { await once(target, "exit"); } finally { clearTimeout(timer); }
    }
    await browser?.close();
    display.kill();
    for (const item of pending.values()) clearTimeout(item.timer);
    await rm(directory, { recursive: true, force: true });
  });
  const [number] = await once(display.stdio[3], "data");
  const env = { ...process.env, DISPLAY: `:${String(number).trim()}`, XDG_SESSION_TYPE: "x11", CITROPY_TEST_DATA: directory };
  delete env.WAYLAND_DISPLAY;
  delete env.ELECTRON_RUN_AS_NODE;
  target = spawn(require("electron"), ["--ozone-platform=x11", "--remote-debugging-port=0", fileURLToPath(new URL("./fixtures/computer-target.mjs", import.meta.url))], { env, stdio: ["pipe", "pipe", "pipe"] });
  let sequence = 0;
  const events = [];
  const waitForEvent = async (description, match, from) => {
    for (let i = 0; i < 750 && !events.slice(from).some(match); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(events.slice(from).some(match), `No ${description} within 15 s. Events since: ${JSON.stringify(events.slice(from))}`);
  };
  const ready = new Promise(resolve => createInterface({ input: target.stdout }).on("line", line => {
    let value;
    try { value = JSON.parse(line); } catch { return; }
    if (value.ready) resolve();
    if (value.event) events.push(value.event);
    const item = pending.get(value.id);
    if (!item) return;
    pending.delete(value.id);
    clearTimeout(item.timer);
    value.error ? item.reject(new Error(value.error)) : item.resolve(value.result);
  }));
  const endpoint = new Promise(resolve => target.stderr.on("data", data => {
    const match = /DevTools listening on (ws:\/\/\S+)/.exec(String(data));
    if (match) resolve(match[1]);
  }));
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => reject(new Error(`Timed out: ${method}`)), 15000);
    pending.set(id, { resolve, reject, timer });
    target.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  await ready;
  browser = await chromium.connectOverCDP(await endpoint);
  const page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(20000);
  assert.equal((await request("computer.capabilities")).backend, "x11");
  assert.deepEqual((await request("computer.start", { control: true })).displays, [{ id: "desktop", name: "Desktop", width: 1200, height: 800 }]);
  const screenshot = await request("computer.screenshot", { displayId: "desktop", maxWidth: 600 });
  assert.deepEqual([screenshot.width, screenshot.height], [600, 400]);
  const jpeg = Buffer.from(screenshot.image, "base64");
  assert.equal(jpeg.subarray(0, 2).toString("hex"), "ffd8");
  await writeFile("/tmp/citropy-computer-native.jpg", jpeg);
  const pixel = await page.evaluate(async source => {
    const image = new Image(); image.src = `data:image/jpeg;base64,${source}`; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = 600; canvas.height = 400;
    const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
    return [...context.getImageData(10, 10, 1, 1).data];
  }, screenshot.image);
  assert.ok(Math.abs(pixel[0] - 21) < 5 && Math.abs(pixel[1] - 35) < 5 && Math.abs(pixel[2] - 47) < 5, JSON.stringify(pixel));
  await page.evaluate(() => {
    const marker = document.createElement("div");
    marker.id = "crop-marker";
    marker.style.cssText = "position:fixed;left:600px;top:400px;width:40px;height:40px;background:rgb(224,96,48);z-index:9999;pointer-events:none";
    document.body.append(marker);
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const cropped = await request("computer.screenshot", { displayId: "desktop", maxWidth: 2560, crop: { x: 0.5, y: 0.5, width: 0.25, height: 0.25 } });
  assert.deepEqual([cropped.width, cropped.height], [300, 200]);
  assert.deepEqual(cropped.crop, { x: 0.5, y: 0.5, width: 0.25, height: 0.25 });
  const detail = await page.evaluate(async source => {
    const image = new Image(); image.src = `data:image/jpeg;base64,${source}`; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
    return { width: image.width, height: image.height, pixel: [...context.getImageData(10, 10, 1, 1).data] };
  }, cropped.image);
  assert.deepEqual([detail.width, detail.height], [300, 200]);
  assert.ok(Math.abs(detail.pixel[0] - 224) < 5 && Math.abs(detail.pixel[1] - 96) < 5 && Math.abs(detail.pixel[2] - 48) < 5);
  await page.locator("#crop-marker").evaluate(element => element.remove());
  await assert.rejects(request("computer.screenshot", { displayId: "desktop", crop: { x: 0.9, y: 0, width: 0.2, height: 0.5 } }), /region/);
  const point = async selector => {
    const box = await page.locator(selector).boundingBox();
    return { displayId: "desktop", x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  };
  await request("computer.action", { action: "click", ...await point("input") });
  await request("computer.action", { action: "type", text: "Hello café ✓" });
  try {
    await page.waitForFunction(() => document.querySelector("input").value === "Hello café ✓");
  } catch (error) {
    t.diagnostic(JSON.stringify(await page.evaluate(() => ({
      value: document.querySelector("input").value,
      focus: document.activeElement?.tagName,
      focused: document.hasFocus(),
      keys: window.keys,
      pointer: window.drag,
    }))));
    throw error;
  }
  await request("computer.action", { action: "press", key: "Control+A" });
  await request("computer.action", { action: "type", text: "Replacement" });
  await page.waitForFunction(() => document.querySelector("input").value === "Replacement");
  await request("computer.action", { action: "click", count: 2, ...await point("#click") });
  await page.waitForFunction(() => document.querySelector("#count").textContent === "2");
  const from = await point("#drag");
  await request("computer.action", { action: "drag", ...from, toX: from.x + 200, toY: from.y + 40, durationMs: 150 });
  await page.waitForFunction(() => window.down === false);
  assert.deepEqual((await page.evaluate(() => window.drag)).slice(-2), [[from.x, from.y], [from.x + 200, from.y + 40]]);
  await request("computer.action", { action: "scroll", ...await point("#scroll"), deltaY: 480 });
  await page.waitForFunction(() => document.querySelector("#scroll").scrollTop > 0);
  await request("computer.pause", { paused: true });
  await assert.rejects(request("computer.action", { action: "type", text: "blocked" }), /paused/);
  assert.equal((await request("computer.screenshot", { displayId: "desktop" })).width, 1200);
  await request("computer.pause", { paused: false });
  const interrupted = request("computer.action", { action: "drag", ...from, toX: from.x + 100, toY: from.y, durationMs: 3000 }).catch(error => error.message);
  await page.waitForFunction(() => window.down === true);
  await request("computer.pause", { paused: true });
  assert.match(await interrupted, /paused/);
  await page.waitForFunction(() => window.down === false);
  await request("computer.pause", { paused: false });
  const stopped = request("computer.action", { action: "drag", ...from, toX: from.x + 100, toY: from.y, durationMs: 3000 }).catch(error => error.message);
  await page.waitForFunction(() => window.down === true);
  await request("computer.stop");
  assert.match(await stopped, /stopped/);
  await page.waitForFunction(() => window.down === false);
  await request("computer.start", { control: false });
  await assert.rejects(request("computer.action", { action: "press", key: "Enter" }), /only allows viewing/);
  await request("computer.screenshot", { displayId: "desktop" });
  const beforeStop = events.length;
  await request("computer.stop");
  await waitForEvent("computer.stopped event after computer.stop", event => event.t === "computer.stopped", beforeStop);
  const finalSession = await request("computer.start", { control: true });
  assert.equal(finalSession.shortcut, true);
  const beforeShortcut = events.length;
  await promisify(execFile)("xdotool", ["key", "ctrl+alt+Escape"], { env });
  await assert.rejects(request("computer.screenshot", { displayId: "desktop" }), /Start a computer session|Stopped/);
  await waitForEvent("stop event naming Ctrl+Alt+Escape", event => event.reason?.includes("Ctrl+Alt+Escape"), beforeShortcut);
  await request("computer.start", { control: true });
  const { stdout: children } = await promisify(execFile)("ps", ["--ppid", String(target.pid), "-o", "pid=,comm="]);
  const helper = /^\s*(\d+)\s+python3$/m.exec(children);
  assert.ok(helper);
  process.kill(Number(helper[1]), "SIGKILL");
  await request("computer.capabilities");
  await request("computer.start", { control: true });
  const { stdout: indicatorChildren } = await promisify(execFile)("ps", ["--ppid", String(target.pid), "-o", "pid=,args="]);
  const indicator = /^\s*(\d+).*--computer-indicator(?:\s|$)/m.exec(indicatorChildren);
  assert.ok(indicator, indicatorChildren);
  const eventCount = events.length;
  process.kill(Number(indicator[1]), "SIGKILL");
  const indicatorStopped = () => events.slice(eventCount).some(event => event.t === "computer.stopped" && event.error === true);
  for (let i = 0; i < 750 && !indicatorStopped(); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(indicatorStopped(), `No computer.stopped error event within 15 s of killing the indicator. Events since: ${JSON.stringify(events.slice(eventCount))}`);
  await assert.rejects(request("computer.screenshot", { displayId: "desktop" }), /Start a computer session/);
  await request("computer.start", { control: true });
  await request("computer.stop");
});
