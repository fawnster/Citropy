import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { chromium } from "playwright";

test("development isolates storage and ports without migrating public data", t => {
  const directory = mkdtempSync(join(tmpdir(), "citropy-development-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, ".loom"));
  writeFileSync(join(directory, ".loom", "preserved"), "legacy data");
  const inspect = (args, overrides = {}) => {
    const env = { ...process.env };
    for (const key of ["CITROPY_DATA_DIR", "CITROPY_PORT", "CITROPY_DEVELOPMENT", "CITROPY_REMOTE_ID"]) delete env[key];
    const script = `
      import os from "node:os";
      import { syncBuiltinESMExports } from "node:module";
      os.homedir = () => ${JSON.stringify(directory)};
      syncBuiltinESMExports();
      process.argv.push(...${JSON.stringify(args)});
      const { dev, port } = await import(${JSON.stringify(new URL("../server/config.ts", import.meta.url).href)});
      const { dataRoot } = await import(${JSON.stringify(new URL("../server/paths.ts", import.meta.url).href)});
      const { builtinSkillRoot } = await import(${JSON.stringify(new URL("../server/builtin-skills.ts", import.meta.url).href)});
      const { receiveAgentEvent, protocolLog } = await import(${JSON.stringify(new URL("../server/providers/events.ts", import.meta.url).href)});
      receiveAgentEvent("codex", "test", { type: "exit", code: "bad" });
      if (dev) await import(${JSON.stringify(new URL("../server/store.ts", import.meta.url).href)});
      process.stdout.write(JSON.stringify({ dev, port, dataRoot, skills: builtinSkillRoot(), events: protocolLog().length }));
    `;
    return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...env, ...overrides }, encoding: "utf8" }));
  };
  const development = inspect(["--dev"]);
  const production = inspect([]);
  assert.deepEqual(development, { dev: true, port: 4178, dataRoot: join(directory, ".citropy-dev"), skills: join(directory, ".citropy-dev", "skills"), events: 1 });
  assert.deepEqual(production, { dev: false, port: 4177, dataRoot: join(directory, ".citropy"), skills: join(directory, ".citropy", "skills"), events: 0 });
  assert.equal(readFileSync(join(directory, ".loom", "preserved"), "utf8"), "legacy data");
  assert.equal(existsSync(join(directory, ".citropy")), false);
  assert.deepEqual(inspect(["--dev", "--packaged"], { CITROPY_DEVELOPMENT: "1" }), production);
  const custom = inspect(["--dev"], { CITROPY_PORT: "4999", CITROPY_DATA_DIR: join(directory, "custom") });
  assert.equal(custom.port, 4999);
  assert.equal(custom.dataRoot, join(directory, "custom"));
});

test("application-menu launchers keep public and development identities separate", t => {
  const directory = mkdtempSync(join(tmpdir(), "citropy-launcher-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const args of [[], ["--dev"]])
    execFileSync(process.execPath, ["desktop/install.mjs", ...args], { env: { ...process.env, XDG_DATA_HOME: directory } });
  const production = readFileSync(join(directory, "applications/citropy.desktop"), "utf8");
  const development = readFileSync(join(directory, "applications/citropy-dev.desktop"), "utf8");
  assert.match(production, /Name=Citropy\n/);
  assert.doesNotMatch(production, /--dev/);
  assert.match(production, /Icon=.*citropy\.png\n/);
  assert.match(development, /Name=Citropy Dev\n/);
  assert.match(development, /--dev/);
  assert.match(development, /Icon=.*citropy-dev\.png\n/);
});

test("development serves an isolated live interface and exposes its controls", { timeout: 60000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "citropy-dev-server-"));
  const reserve = async () => {
    const server = createServer();
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    return server;
  };
  const backend = await reserve();
  const frontend = await reserve();
  const port = backend.address().port;
  const uiPort = frontend.address().port;
  await Promise.all([backend, frontend].map(server => new Promise(resolve => server.close(resolve))));
  const server = spawn(process.execPath, ["--experimental-strip-types", "server/main.ts", "--dev"], {
    env: { ...process.env, CITROPY_PORT: String(port), CITROPY_UI_PORT: String(uiPort), CITROPY_DATA_DIR: directory },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  let browser;
  let conflict;
  server.stdout.on("data", chunk => { output += chunk; });
  server.stderr.on("data", chunk => { output += chunk; });
  t.after(async () => {
    conflict?.kill("SIGTERM");
    await browser?.close();
    if (server.exitCode === null) {
      const stopped = once(server, "exit");
      server.kill("SIGTERM");
      await stopped;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  await Promise.race([
    once(server, "message"),
    once(server, "exit").then(() => { throw new Error(output); }),
  ]);
  const url = `http://127.0.0.1:${uiPort}`;
  const health = await (await fetch(`${url}/api/health`)).json();
  assert.equal(health.development, true);
  assert.equal(health.app, "citropy");
  const redirect = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
  assert.equal(redirect.headers.get("location"), `${url}/`);
  const diagnostics = await (await fetch(`${url}/api/diagnostics`)).json();
  assert.ok(Array.isArray(diagnostics.protocol));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await page.goto(url);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Application", exact: true }).click();
  await page.getByRole("heading", { name: "Citropy development", exact: true }).waitFor();
  assert.equal(await page.getByText("Live updates on", { exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "Restart server", exact: true }).count(), 1);
  await page.screenshot({ path: "/tmp/citropy-development-settings.png", animations: "disabled" });
  await page.getByRole("button", { name: "Resources", exact: true }).click();
  await page.getByText(/Provider events/).waitFor();
  const alternate = await reserve();
  const alternatePort = alternate.address().port;
  await new Promise(resolve => alternate.close(resolve));
  conflict = spawn(process.execPath, ["--experimental-strip-types", "server/main.ts", "--dev"], {
    env: { ...process.env, CITROPY_PORT: String(alternatePort), CITROPY_UI_PORT: String(uiPort), CITROPY_DATA_DIR: join(directory, "conflict") },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let failure = "";
  conflict.stderr.on("data", chunk => { failure += chunk; });
  const [code] = await once(conflict, "exit");
  assert.equal(code, 1);
  assert.match(failure, /already in use/);
});
