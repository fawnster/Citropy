import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../release/", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "citropy-win-smoke-"));
const exists = (path) => access(path).then(() => true, () => false);
let desktop;

const kill = (child) => {
  if (child.exitCode !== null) return;
  spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
};

try {
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const files = await readdir(root);
  const setup = `Citropy-${version}-x64-Setup.exe`;
  assert.ok(files.includes(setup), `Build ${setup} before running the Windows smoke check. Found: ${files.join(", ")}`);
  const app = join(root, "win-unpacked");
  const appRoot = join(app, "resources/app");
  await access(join(app, "Citropy.exe"));
  await access(join(appRoot, "LICENSE"));
  await access(join(appRoot, "dist/index.html"));
  await access(join(appRoot, "node_modules/@fontsource-variable/inter/files/inter-latin-standard-normal.woff2"));
  const notices = await readFile(join(appRoot, "dist/THIRD_PARTY_NOTICES.txt"), "utf8");
  for (const path of ["react/LICENSE", "lucide-react/LICENSE", "@fontsource-variable/geist-mono/LICENSE", "tslib/CopyrightNotice.txt"]) {
    assert.ok(notices.includes(await readFile(new URL(`../node_modules/${path}`, import.meta.url), "utf8")), `Missing bundled dependency notice: ${path}`);
  }
  for (const path of [".env", "tests", ".git", "web", "desktop/start.mjs", "desktop/install.mjs", "desktop/smoke.mjs", "desktop/smoke-mac.mjs", "desktop/smoke-win.mjs", "node_modules/vite", "node_modules/playwright", "node_modules/lucide-react", "node_modules/shiki", "node_modules/motion"]) {
    assert.equal(await exists(join(appRoot, path)), false, `Development file in release: ${path}`);
  }
  assert.equal(JSON.parse(await readFile(join(appRoot, "package.json"), "utf8")).version, version);
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  desktop = spawn(join(app, "Citropy.exe"), [], {
    env: {
      ...process.env,
      CITROPY_PORT: String(port),
      CITROPY_DATA_DIR: join(directory, "data"),
      CITROPY_DESKTOP_DATA: join(directory, "desktop"),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let output = "";
  desktop.stderr.on("data", (chunk) => {
    output = `${output}${chunk}`.slice(-2000);
  });
  let health;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && desktop.exitCode === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(health, `Citropy's server never answered on port ${port}.${output ? `\n${output}` : ""}`);
  assert.equal(health.ok, true);
  assert.equal(health.development, false);
  kill(desktop);
  desktop = undefined;
  console.log(`Citropy ${version}: Windows installer and unpacked app verified, and the packaged app passed startup.`);
} finally {
  if (desktop) kill(desktop);
  await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
