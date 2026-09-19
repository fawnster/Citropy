import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm, access, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { _electron as electron } from "playwright";

const root = fileURLToPath(new URL("../release/linux-unpacked/", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "citropy-release-smoke-"));
const display = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1440x1000x24"], { stdio: ["ignore", "ignore", "pipe", "pipe"] });
let desktop;
try {
  const [number] = await once(display.stdio[3], "data");
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const appRoot = join(root, "resources/app");
  await access(join(appRoot, "LICENSE"));
  await access(join(appRoot, "dist/index.html"));
  for (const path of [".env", "tests", ".git", "web", "desktop/start.mjs", "desktop/install.mjs", "desktop/smoke.mjs", "desktop/smoke-mac.mjs", "node_modules/vite", "node_modules/playwright"]) {
    const present = await access(join(appRoot, path)).then(() => true, () => false);
    assert.equal(present, false, `Development file in release: ${path}`);
  }
  const { version } = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8"));
  const artifact = (await readdir(join(root, ".."))).find(name => name.startsWith(`Citropy-${version}-`) && name.endsWith(".AppImage"));
  assert.ok(artifact, "Build the AppImage before running the release smoke check.");
  desktop = await electron.launch({
    executablePath: join(root, "..", artifact),
    args: ["--no-sandbox", "--ozone-platform=x11"],
    env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1", DISPLAY: `:${String(number).trim()}`, CITROPY_PORT: String(port), CITROPY_DATA_DIR: join(directory, "data"), CITROPY_DESKTOP_DATA: join(directory, "desktop"), CITROPY_DEVELOPMENT: "1" },
    timeout: 60000,
  });
  assert.equal(await desktop.evaluate(({ app }) => app.isPackaged), true);
  const page = await desktop.firstWindow({ timeout: 60000 });
  await page.getByRole("button", { name: "Settings", exact: true }).waitFor({ timeout: 30000 });
  const state = await page.evaluate(() => window.citropyDesktop.windowState());
  assert.equal(state.development, false);
  assert.equal(state.version, version);
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await (await fetch(`${base}/api/health`)).json()).development, false);
  assert.equal((await fetch(`${base}/api/desktop?development=1`, { method: "POST" })).status, 403);
  const diagnostics = await (await fetch(`${base}/api/diagnostics`)).json();
  assert.equal(Object.hasOwn(diagnostics, "protocol"), false);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Application", exact: true }).click();
  assert.equal(await page.getByText("Live interface updates", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Restart server", exact: true }).count(), 0);
  assert.equal(await page.getByText(/Interface edits update live/).count(), 0);
  await page.getByRole("heading", { name: "Application", exact: true, level: 1 }).waitFor();
  await page.getByRole("heading", { name: "General", exact: true, level: 1 }).waitFor({ state: "detached" });
  for (const width of [1440, 960]) {
    await desktop.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900), width);
    await page.screenshot({ path: join(root, "..", `smoke-${width}.png`), animations: "disabled" });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  await desktop.close();
  desktop = undefined;
  await assert.rejects(fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) }));
  console.log(`Citropy ${version}: packaged startup, shutdown, release contents, and development restrictions passed.`);
} finally {
  await desktop?.close();
  display.kill();
  await rm(directory, { recursive: true, force: true });
}
