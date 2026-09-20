import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";
import { createAppUpdater } from "../desktop/updates.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(overrides = {}) {
  const updater = new EventEmitter();
  const calls = [];
  updater.checkForUpdates = async () => {
    calls.push("check");
    updater.emit("update-available", { version: "0.2.0" });
    return {};
  };
  updater.downloadUpdate = async () => {
    calls.push("download");
    updater.emit("download-progress", {
      percent: 46.5,
      transferred: 465,
      total: 1000,
    });
    updater.emit("update-downloaded", { version: "0.2.0" });
  };
  updater.quitAndInstall = (silent, restart) => {
    calls.push(["install", silent, restart]);
  };
  const history = [];
  const control = createAppUpdater({
    updater,
    version: "0.1.0",
    emit: (state) => history.push(state),
    prepareInstall: async () => {
      calls.push("prepare");
    },
    ...overrides,
  });
  return { updater, calls, history, control };
}

test("release updates require separate download and apply actions and clean up listeners", async (t) => {
  const { updater, control, calls, history } = fixture();
  t.after(() => control.dispose());
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowDowngrade, false);
  await control.command("check");
  await tick();
  assert.equal(control.state().status, "available");
  assert.deepEqual(calls, ["check"]);
  await assert.rejects(control.command("install"), /Download and verify/);
  await control.command("download");
  await tick();
  assert.equal(control.state().status, "ready");
  assert.equal(control.state().percent, 100);
  assert.ok(
    history.some(
      (state) => state.status === "downloading" && state.percent === 46.5,
    ),
  );
  assert.deepEqual(calls, ["check", "download"]);
  await control.command("check");
  assert.equal(control.state().status, "ready");
  await control.command("install");
  await tick();
  assert.deepEqual(calls, [
    "check",
    "download",
    "prepare",
    ["install", false, true],
  ]);
  control.dispose();
  assert.equal(updater.eventNames().length, 0);
});

test("duplicate clicks, no release, verification failures, and blocked restarts preserve the current app", async (t) => {
  let release;
  let failure = false;
  const { updater, control, calls } = fixture({
    prepareInstall: async () => {
      if (failure)
        throw Object.assign(new Error("busy"), {
          userMessage: "Finish active conversations first.",
        });
    },
  });
  t.after(() => control.dispose());
  await control.command("check");
  await tick();
  updater.downloadUpdate = () =>
    new Promise((resolve) => {
      calls.push("download");
      release = resolve;
    });
  await control.command("download");
  await control.command("download");
  assert.deepEqual(calls, ["check", "download"]);
  updater.emit("update-downloaded", { version: "0.9.0" });
  assert.equal(control.state().status, "downloading");
  updater.emit(
    "error",
    Object.assign(new Error("checksum mismatch"), {
      code: "ERR_UPDATER_CHECKSUM_MISMATCH",
    }),
  );
  release();
  await tick();
  assert.equal(control.state().status, "error");
  assert.equal(control.state().retry, "download");
  assert.match(control.state().message, /verification/);
  await assert.rejects(control.command("install"), /Download and verify/);
  await control.command("download");
  updater.emit("update-downloaded", { version: "0.2.0" });
  release();
  await tick();
  failure = true;
  await control.command("install");
  await tick();
  assert.equal(control.state().status, "error");
  assert.equal(control.state().message, "Finish active conversations first.");
  assert.ok(!calls.some((call) => Array.isArray(call)));
  failure = false;
  await control.command("install");
  await tick();
  assert.ok(calls.some((call) => Array.isArray(call)));
});

test("development builds cannot download and current versions cannot downgrade", async (t) => {
  const disabled = fixture({ unavailable: "Development build" });
  t.after(() => disabled.control.dispose());
  await disabled.control.command("download");
  assert.equal(disabled.control.state().status, "unsupported");
  assert.deepEqual(disabled.calls, []);
  const { control, updater } = fixture();
  t.after(() => control.dispose());
  updater.checkForUpdates = async () => {
    updater.emit("update-available", { version: "0.0.9" });
    return {};
  };
  await control.command("check");
  await tick();
  assert.equal(control.state().status, "current");
  await assert.rejects(control.command("download"), /new release/);
});

test(
  "sidebar update control shows hover progress and only applies a verified download",
  { timeout: 40000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "citropy-update-ui-"));
    let server;
    let browser;
    t.after(async () => {
      await browser?.close();
      await server?.close();
      await rm(directory, { recursive: true, force: true });
    });
    const fixtureSource = `import React from 'react';
import { createRoot } from 'react-dom/client';
import { SidebarFooter } from '/web/src/components/SidebarFooter.tsx';
import '/web/src/styles/tokens.css';
import '/web/src/styles/base.css';
import '/web/src/styles/sidebar.css';
const root = document.getElementById('root');
root.style.cssText = 'height:var(--viewport-height);display:flex;max-width:100%;background:var(--canvas)';
createRoot(root).render(React.createElement('aside', {className:'rail', style:{width:280}}, React.createElement('div', {style:{padding:24,fontSize:17}}, 'Citropy'), React.createElement('div', {style:{padding:24,color:'var(--text-3)',flex:1}}, 'Your conversations'), React.createElement(SidebarFooter, {onGit(){},onGitHub(){},onSettings(){},onUsage(){}})));
`;
    server = await createServer({
      configFile: false,
      root: fileURLToPath(new URL("..", import.meta.url)),
      cacheDir: join(directory, "node_modules", ".vite"),
      plugins: [
        react(),
        {
          name: "update-fixture",
          resolveId(id) {
            if (id === "/__update_fixture.tsx") return id;
          },
          load(id) {
            if (id === "/__update_fixture.tsx") return fixtureSource;
          },
        },
      ],
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, watch: null },
    });
    await server.listen();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1400, height: 900 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem("citropy.compactNavigation", "1");
      let state = {
        status: "available",
        currentVersion: "0.1.0",
        version: "0.2.0",
      };
      let listener;
      window.updateCalls = [];
      window.publishUpdate = (patch) => {
        state = { ...state, ...patch };
        listener?.(state);
      };
      window.citropyDesktop = {
        updateState: async () => state,
        onUpdateState: (callback) => {
          listener = callback;
          return () => {
            listener = undefined;
          };
        },
        updateCommand: async (action) => {
          window.updateCalls.push(action);
          window.publishUpdate({
            status:
              action === "download"
                ? "downloading"
                : action === "install"
                  ? "installing"
                  : "current",
            percent: action === "download" ? 0 : undefined,
          });
          return state;
        },
      };
    });
    const html =
      '<!doctype html><html data-theme="dark"><div id="root"></div><script type="module" src="/__update_fixture.tsx"></script></html>';
    await page.route("**/update-fixture", async (route) =>
      route.fulfill({
        contentType: "text/html",
        body: await server.transformIndexHtml("/update-fixture", html),
      }),
    );
    await page.goto(`${server.resolvedUrls.local[0]}update-fixture`);
    const button = page.getByRole("button", {
      name: "Download update",
      exact: true,
    });
    await button.waitFor({ timeout: 10000 }).catch((error) => {
      throw new Error(`${error.message}: ${errors.join("; ")}`);
    });
    await button.hover();
    await page
      .getByRole("tooltip")
      .getByText("Citropy 0.2.0 is available")
      .waitFor();
    await button.click();
    await page.evaluate(() =>
      window.publishUpdate({
        percent: 42.8,
        transferred: 44040192,
        total: 104857600,
        bytesPerSecond: 2097152,
      }),
    );
    const progress = page.locator('[role="progressbar"][aria-valuenow="42"]');
    await progress.waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Downloading 42%" }).isDisabled(),
      true,
    );
    await page
      .getByRole("button", { name: "Downloading 42%" })
      .click({ force: true });
    assert.deepEqual(await page.evaluate(() => window.updateCalls), [
      "download",
    ]);
    await page
      .getByRole("progressbar")
      .locator("div")
      .evaluate(async (node) => {
        await Promise.all(
          node.getAnimations().map((animation) => animation.finished),
        );
      });
    await page.screenshot({ path: "/tmp/citropy-update-footer-desktop.png" });
    const colors = await page
      .locator(".navigation-actions [data-tone] > svg")
      .evaluateAll((nodes) =>
        nodes.map((node) => getComputedStyle(node).color),
      );
    assert.equal(new Set(colors).size, 1);
    assert.equal(
      await page
        .locator(".navigation-handle svg, .navigation-handle span")
        .count(),
      0,
    );
    await page.setViewportSize({ width: 600, height: 720 });
    await page.getByRole("button", { name: "Downloading 42%" }).hover();
    await page.screenshot({ path: "/tmp/citropy-update-footer-narrow.png" });
    const popup = await page.getByRole("tooltip").boundingBox();
    assert.ok(popup.x >= 0 && popup.x + popup.width <= 600);
    await page.evaluate(() =>
      window.publishUpdate({ status: "ready", percent: 100 }),
    );
    await page
      .getByRole("tooltip")
      .getByText(/Download verified/)
      .waitFor();
    await page.getByRole("button", { name: "Restart & apply" }).click();
    assert.deepEqual(await page.evaluate(() => window.updateCalls), [
      "download",
      "install",
    ]);
    await page.getByRole("button", { name: "Expand navigation" }).click();
    await page.getByRole("button", { name: "Usage", exact: true }).waitFor();
    assert.equal(
      await page.locator(".navigation-footer").getAttribute("data-compact"),
      "false",
    );
    assert.deepEqual(errors, []);
  },
);

