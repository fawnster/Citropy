import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../release/", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "citropy-mac-smoke-"));
const exists = (path) => access(path).then(() => true, () => false);
const hostArch = process.arch === "x64" ? "x86_64" : "arm64";
let desktop;

try {
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const appName = "Citropy";
  const files = await readdir(root);
  const zips = files.filter((name) => name.endsWith(".zip") && (name.includes("-arm64") || name.includes("-x64")));
  assert.equal(zips.length, 2, `Build both macOS zips before running the macOS smoke check. Found: ${files.join(", ")}`);
  for (const zip of zips) {
    const arch = zip.includes("-arm64") ? "arm64" : "x86_64";
    const folder = join(directory, arch);
    await run("ditto", ["-x", "-k", join(root, zip), folder]);
    const app = join(folder, `${appName}.app`);
    await run("codesign", ["--verify", "--deep", "--strict", app]);
    const appRoot = join(app, "Contents/Resources/app");
    await access(join(appRoot, "LICENSE"));
    await access(join(appRoot, "dist/index.html"));
    await access(join(appRoot, "node_modules/@fontsource-variable/inter/files/inter-latin-standard-normal.woff2"));
    const notices = await readFile(join(appRoot, "dist/THIRD_PARTY_NOTICES.txt"), "utf8");
    for (const path of ["react/LICENSE", "lucide-react/LICENSE", "@fontsource-variable/geist-mono/LICENSE", "tslib/CopyrightNotice.txt"]) {
      assert.ok(notices.includes(await readFile(new URL(`../node_modules/${path}`, import.meta.url), "utf8")), `Missing bundled dependency notice: ${path}`);
    }
    await access(join(app, "Contents/Info.plist"));
    for (const path of [".env", "tests", ".git", "web", "desktop/start.mjs", "desktop/install.mjs", "desktop/smoke.mjs", "desktop/smoke-mac.mjs", "desktop/smoke-win.mjs", "desktop/computer-mac.swift", "desktop/computer-mac-build.mjs", "node_modules/vite", "node_modules/playwright", "node_modules/lucide-react", "node_modules/shiki", "node_modules/motion"]) {
      assert.equal(await exists(join(appRoot, path)), false, `Development file in release: ${path}`);
    }
    assert.equal(JSON.parse(await readFile(join(appRoot, "package.json"), "utf8")).version, version);
    const binary = await run("lipo", ["-archs", join(app, `Contents/MacOS/${appName}`)]);
    assert.equal(binary.stdout.trim(), arch, `${zip} contains the wrong architecture for its name.`);
    for (const name of ["node_modules/node-pty/build/Release/pty.node", "node_modules/node-pty/build/Release/spawn-helper"]) {
      if (!(await exists(join(appRoot, name)))) continue;
      const native = await run("lipo", ["-archs", join(appRoot, name)]);
      assert.equal(native.stdout.trim(), arch, `${name} in ${zip} contains the wrong architecture.`);
    }
    const helper = join(appRoot, "desktop/computer-mac");
    assert.deepEqual((await run("lipo", ["-archs", helper])).stdout.trim().split(/\s+/).sort(), ["arm64", "x86_64"], "The macOS computer helper must be universal.");
    await run("codesign", ["--verify", helper]);
    if (arch === hostArch) assert.equal(JSON.parse((await run(helper, ["--probe"])).stdout).platform, "darwin");
    if (arch !== hostArch) {
      console.log(`${zip}: ${arch} bundle verified without launching (host is ${hostArch}).`);
      continue;
    }
    const probe = createServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    desktop = spawn(join(app, `Contents/MacOS/${appName}`), [], {
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
    const exited = new Promise((resolve) => desktop.once("exit", (code, signal) => resolve({ code, signal })));
    desktop.kill("SIGTERM");
    let shutdownTimer;
    const result = await Promise.race([
      exited,
      new Promise((resolve) => { shutdownTimer = setTimeout(() => resolve(undefined), 45000); }),
    ]).finally(() => clearTimeout(shutdownTimer));
    assert.ok(result, `Citropy did not quit after SIGTERM.${output ? `\n${output}` : ""}`);
    assert.equal(result.signal, null, `Citropy exited from ${result.signal} instead of quitting cleanly.`);
    assert.equal(result.code, 0);
    desktop = undefined;
  }
  console.log(`Citropy ${version}: both macOS bundles verified, and the ${hostArch} app passed startup and shutdown.`);
} finally {
  if (desktop && desktop.exitCode === null) desktop.kill("SIGKILL");
  await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
