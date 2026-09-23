import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron } from "playwright";

test("screen indicator stays above apps without taking focus and releases its windows", { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-indicator-test-"));
  const display = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1200x800x24"], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
  let desktop;
  t.after(async () => { await desktop?.close(); display.kill(); await rm(directory, { recursive: true, force: true }); });
  const [number] = await once(display.stdio[3], "data");
  const env = { ...process.env, DISPLAY: `:${String(number).trim()}`, CITROPY_INDICATOR_DATA: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const fixture = join(directory, "indicator.mjs");
  await writeFile(fixture, `import { PassThrough } from "node:stream"; Object.defineProperty(process, "stdin", { value: new PassThrough() }); await import(${JSON.stringify(new URL("../desktop/entry.mjs", import.meta.url).href)});`);
  desktop = await _electron.launch({ args: ["--ozone-platform=x11", fixture, "--computer-indicator"], env });
  const hostReady = desktop.waitForEvent("window");
  await desktop.evaluate(async ({ BrowserWindow }) => {
    const host = new BrowserWindow({ x: 0, y: 100, width: 800, height: 500, frame: false });
    await host.loadURL('data:text/html,<title>Typing target</title><input autofocus aria-label="Typing target">');
    host.focus();
  });
  const host = await hostReady;
  const input = host.getByRole("textbox", { name: "Typing target" });
  await input.focus();
  const actions = [];
  let state = { control: true, paused: false, shortcut: true, displays: [{ id: "screen", x: 0, y: 0, width: 1200, height: 800 }] };
  const update = patch => { state = { ...state, ...patch }; return desktop.evaluate((_, value) => process.stdin.write(`${JSON.stringify(value)}\n`), state); };
  createInterface({ input: desktop.process().stdout }).on("line", line => {
    let value;
    try { value = JSON.parse(line); } catch { return; }
    if (value.action) {
      actions.push(value.action);
      if (value.action !== "stop") update({ paused: value.action === "pause" });
    }
  });
  const indicatorReady = desktop.waitForEvent("window");
  await update({});
  const page = await indicatorReady;
  await page.getByRole("status").getByText("Citropy is controlling this screen", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Stop computer use", exact: true }).getAttribute("title"), `Stop computer use (${process.platform === "darwin" ? "Control+Option+Escape" : "Ctrl+Alt+Escape"})`);
  await page.evaluate(() => document.fonts.ready);
  const windowState = () => desktop.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(window => window.getTitle() === "Citropy computer use");
    return { bounds: window.getBounds(), focusable: window.isFocusable(), visible: window.isVisible(), top: window.isAlwaysOnTop(), focused: BrowserWindow.getFocusedWindow()?.getTitle() };
  });
  const shown = await windowState();
  assert.equal(shown.focusable, false);
  assert.equal(shown.top, true);
  assert.equal(shown.visible, true);
  assert.equal(shown.focused, "Typing target");
  assert.equal(shown.bounds.height, 48);
  assert.ok(shown.bounds.x >= 0 && shown.bounds.x + shown.bounds.width <= 1200);
  await page.screenshot({ path: "/tmp/citropy-indicator-active.png" });
  const click = async locator => {
    const box = await locator.boundingBox();
    const { bounds } = await windowState();
    execFileSync("xdotool", ["mousemove", "--sync", String(Math.round(bounds.x + box.x + box.width / 2)), String(Math.round(bounds.y + box.y + box.height / 2)), "click", "1"], { env });
  };
  await click(page.getByRole("button", { name: "Pause computer use", exact: true }));
  await page.getByRole("status").getByText("Computer use paused", { exact: true }).waitFor();
  assert.equal((await windowState()).focused, "Typing target");
  execFileSync("xdotool", ["type", "Still typing"], { env });
  await host.waitForFunction(() => document.querySelector("input").value === "Still typing");
  await page.screenshot({ path: "/tmp/citropy-indicator-paused.png" });
  await click(page.getByRole("button", { name: "Resume computer use", exact: true }));
  await page.getByRole("status").getByText("Citropy is controlling this screen", { exact: true }).waitFor();
  await update({ control: false });
  await page.getByRole("status").getByText("Citropy is viewing this screen", { exact: true }).waitFor();
  await update({ language: "es" });
  await page.getByRole("status").getByText("Citropy ve esta pantalla", { exact: true }).waitFor();
  await click(page.getByRole("button", { name: "Detener uso del ordenador", exact: true }));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(actions, ["pause", "resume", "stop"]);
  const closed = page.waitForEvent("close");
  await desktop.evaluate(() => { process.stdin.end(); });
  await closed;
});
