import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

test(
  "the settings channel switch confirms before it asks the desktop to switch",
  { timeout: 60000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "citropy-channel-switch-"));
    let server;
    let browser;
    t.after(async () => {
      await browser?.close();
      await server?.close();
      await rm(directory, { recursive: true, force: true });
    });
    const fixtureSource = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChannelSwitch } from '/web/src/components/ChannelSwitch.tsx';
import { ConfirmationDialog } from '/web/src/components/ConfirmationDialog.tsx';
import { useApp } from '/web/src/lib/store.ts';
import '/web/src/styles/tokens.css';
import '/web/src/styles/base.css';
import '/web/src/styles/settings.css';
import '/web/src/styles/app.css';
import '/web/src/styles/overlays.css';
useApp.setState({ connected: true });
createRoot(document.getElementById('root')).render(
  React.createElement(React.Fragment, null, React.createElement('div', {className:'settings-group'}, React.createElement(ChannelSwitch, null)), React.createElement(ConfirmationDialog, null)),
);
`;
    server = await createServer({
      configFile: false,
      root: fileURLToPath(new URL("..", import.meta.url)),
      cacheDir: join(directory, "node_modules", ".vite"),
      plugins: [
        react(),
        {
          name: "channel-switch-fixture",
          resolveId(id) {
            if (id === "/__channel_switch.tsx") return id;
          },
          load(id) {
            if (id === "/__channel_switch.tsx") return fixtureSource;
          },
        },
      ],
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, watch: null },
    });
    await server.listen();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.switchCalls = [];
      let listener;
      window.publishUpdate = (patch) => listener?.(patch);
      window.citropyDesktop = {
        windowState: async () => ({
          channel: "stable",
          development: false,
          switchable: true,
        }),
        onUpdateState: (callback) => {
          listener = callback;
          return () => {
            listener = undefined;
          };
        },
        updateCommand: async (request) => {
          window.switchCalls.push(request);
        },
      };
    });
    const html =
      '<!doctype html><html><div id="root"></div><script type="module" src="/__channel_switch.tsx"></script></html>';
    await page.route("**/channel-switch", async (route) =>
      route.fulfill({
        contentType: "text/html",
        body: await server.transformIndexHtml("/channel-switch", html),
      }),
    );
    await page.goto(`${server.resolvedUrls.local[0]}channel-switch`);
    const button = page.getByRole("button", { name: "Use the Lemon build" });
    await button.waitFor({ timeout: 10000 });
    await button.click();
    const dialog = page.locator(".citropy-dialog");
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /conversations, settings, and terminals stay/);
    await page.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "detached" });
    assert.deepEqual(await page.evaluate(() => window.switchCalls), []);
    await button.click();
    await dialog.waitFor();
    await page.getByRole("button", { name: "Switch and reopen" }).click();
    assert.deepEqual(await page.evaluate(() => window.switchCalls), [
      { action: "switch", channel: "lemon" },
    ]);
    await page.evaluate(() =>
      window.publishUpdate({
        status: "installing",
        message: "Downloading the Lemon build and reopening Citropy.",
      }),
    );
    await page.getByRole("button", { name: "Switching…" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Switching…" }).isDisabled(), true);
    await page.evaluate(() =>
      window.publishUpdate({
        status: "error",
        message: "The channel did not switch. Citropy is still on the stable build.",
      }),
    );
    await page
      .getByText("The channel did not switch. Citropy is still on the stable build.")
      .waitFor();
    assert.equal(await button.isEnabled(), true);
    assert.deepEqual(errors, []);
  },
);

test(
  "a build that cannot replace itself hides the channel switch",
  { timeout: 60000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "citropy-channel-hidden-"));
    let server;
    let browser;
    t.after(async () => {
      await browser?.close();
      await server?.close();
      await rm(directory, { recursive: true, force: true });
    });
    const fixtureSource = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChannelSwitch } from '/web/src/components/ChannelSwitch.tsx';
import '/web/src/styles/tokens.css';
import '/web/src/styles/base.css';
import '/web/src/styles/settings.css';
createRoot(document.getElementById('root')).render(React.createElement(ChannelSwitch, null));
`;
    server = await createServer({
      configFile: false,
      root: fileURLToPath(new URL("..", import.meta.url)),
      cacheDir: join(directory, "node_modules", ".vite"),
      plugins: [
        react(),
        {
          name: "channel-hidden-fixture",
          resolveId(id) {
            if (id === "/__channel_hidden.tsx") return id;
          },
          load(id) {
            if (id === "/__channel_hidden.tsx") return fixtureSource;
          },
        },
      ],
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, watch: null },
    });
    await server.listen();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await page.addInitScript(() => {
      window.citropyDesktop = {
        windowState: async () => ({
          channel: "stable",
          development: false,
          switchable: false,
        }),
      };
    });
    const html =
      '<!doctype html><html><div id="root"></div><script type="module" src="/__channel_hidden.tsx"></script></html>';
    await page.route("**/channel-hidden", async (route) =>
      route.fulfill({
        contentType: "text/html",
        body: await server.transformIndexHtml("/channel-hidden", html),
      }),
    );
    await page.goto(`${server.resolvedUrls.local[0]}channel-hidden`);
    await page.waitForTimeout(1000);
    assert.equal(
      await page.getByRole("button", { name: "Use the Lemon build" }).count(),
      0,
    );
  },
);
