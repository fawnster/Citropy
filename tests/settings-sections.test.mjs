import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

test("settings sections preserve preferences and application lifecycle", { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-settings-sections-"));
  let server;
  let browser;
  t.after(async () => {
    await browser?.close();
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const source = `import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Settings } from "/web/src/components/Settings.tsx";
import { ConfirmationDialog } from "/web/src/components/ConfirmationDialog.tsx";
import { useApp } from "/web/src/lib/store.ts";
import { initializeEnvironment, selectEnvironment } from "/web/src/lib/environment.ts";
import { connect } from "/web/src/lib/socket.ts";
import "/web/src/styles/tokens.css";
import "/web/src/styles/base.css";
import "/web/src/styles/app.css";
import "/web/src/styles/sidebar.css";
import "/web/src/styles/settings.css";
import "/web/src/styles/overlays.css";
await initializeEnvironment();
useApp.setState({ connected: true, development: true });
window.settingsStore = useApp;
window.changeEnvironment = selectEnvironment;
connect();
function Fixture() {
  const [open, setOpen] = useState(true);
  return <><button onClick={() => setOpen(value => !value)}>Toggle navigation</button><Settings sidebarOpen={open} onCloseSidebar={() => setOpen(false)} onBack={() => {}} /><ConfirmationDialog /></>;
}
const root = createRoot(document.getElementById("root"));
window.unmountSettings = () => root.unmount();
root.render(<React.StrictMode><Fixture /></React.StrictMode>);`;
  server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("..", import.meta.url)),
    cacheDir: join(directory, "cache"),
    plugins: [react(), {
      name: "settings-fixture",
      resolveId(id) { if (id === "/__settings_fixture.tsx") return id; },
      load(id) { if (id === "/__settings_fixture.tsx") return source; },
    }],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, watch: null },
  });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  async function fixture(desktop = true) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    const errors = [];
    const requests = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(desktop => {
      for (const [key, value] of Object.entries({ theme: "dark", uiScale: "100", textStreaming: "1", typingAnimation: "0", uiSounds: "0" })) localStorage.setItem(`citropy.${key}`, value);
      if (!desktop) return;
      let activeId = "local";
      let update = { status: "current", currentVersion: "0.4.2" };
      const windows = new Set();
      const updates = new Set();
      window.desktopRequests = [];
      window.pendingDesktopActions = [];
      window.desktopListenerCounts = () => ({ windows: windows.size, updates: updates.size });
      window.publishDesktopUpdate = status => {
        update = { ...update, status };
        for (const callback of updates) callback(update);
      };
      const environment = () => ({ activeId, endpoint: activeId === "local" ? "" : "http://127.0.0.1:49122", connections: [] });
      window.citropyDesktop = {
        environmentsState: async () => environment(),
        onEnvironmentsState: () => () => {},
        connectEnvironment: async id => { activeId = id; return environment(); },
        windowState: async () => {
          window.desktopRequests.push("windowState");
          return { platform: "linux", maximized: false, fullscreen: false, development: true, version: "0.4.2", electron: "44", notifications: true };
        },
        onWindowState: callback => { windows.add(callback); return () => windows.delete(callback); },
        updateState: async () => update,
        onUpdateState: callback => { updates.add(callback); return () => updates.delete(callback); },
        windowCommand: action => {
          window.desktopRequests.push(action);
          return new Promise((resolve, reject) => window.pendingDesktopActions.push({ resolve, reject }));
        },
      };
    }, desktop);
    await page.routeWebSocket("**/socket", socket => {
      socket.onMessage(raw => {
        const event = JSON.parse(raw);
        requests.push(event);
        if (event.t === "notifications.configure") socket.send(JSON.stringify({ t: "notifications.preferences", preferences: { toasts: true, desktop: true, sound: false, subagents: false, ...event.preferences } }));
      });
      socket.send(JSON.stringify({ t: "reconnected", epoch: "settings", sequence: 0 }));
    });
    const html = '<!doctype html><html data-theme="dark"><body><div id="root" style="height:100vh;display:flex;flex-direction:column"></div><script type="module" src="/__settings_fixture.tsx"></script></body></html>';
    await page.route("**/settings-fixture", async route => route.fulfill({ contentType: "text/html", body: await server.transformIndexHtml("/settings-fixture", html) }));
    await page.goto(new URL("settings-fixture", server.resolvedUrls.local[0]).href);
    await page.getByRole("heading", { name: "General", exact: true }).waitFor();
    return { page, requests, close: async () => { assert.deepEqual(errors, []); await page.close(); } };
  }

  await t.test("general, appearance and notification controls keep their store-backed state", async () => {
    const f = await fixture();
    const { page } = f;
    await page.getByRole("switch", { name: /^Text streaming/ }).uncheck();
    await page.getByRole("switch", { name: /^Typing animation/ }).check();
    await page.getByRole("slider", { name: "Typing speed", exact: true }).fill("160");
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await page.getByRole("button", { name: "Light", exact: true }).click();
    await page.getByRole("slider", { name: "UI size", exact: true }).fill("105");
    assert.equal(await page.getByRole("button", { name: "Light", exact: true }).getAttribute("aria-pressed"), "true");
    await page.getByRole("button", { name: "Dark", exact: true }).click();
    await page.getByRole("slider", { name: "UI size", exact: true }).fill("100");
    await page.getByRole("button", { name: "Notifications", exact: true }).click();
    assert.equal(await page.getByRole("switch", { name: /^Subagent completions/ }).isChecked(), false);
    await page.getByRole("switch", { name: /^Subagent completions/ }).click();
    await page.waitForFunction(() => window.settingsStore.getState().notificationPreferences.subagents);
    assert.equal(await page.getByRole("switch", { name: /^Subagent completions/ }).isChecked(), true);
    await page.getByRole("slider", { name: "Volume", exact: true }).fill("35");
    await page.getByRole("button", { name: "General", exact: true }).click();
    assert.equal(await page.getByRole("switch", { name: /^Text streaming/ }).isChecked(), false);
    assert.equal(await page.getByRole("switch", { name: /^Typing animation/ }).isChecked(), true);
    assert.equal(await page.getByRole("slider", { name: "Typing speed", exact: true }).inputValue(), "160");
    assert.deepEqual(await page.evaluate(() => ["textStreaming", "typingAnimation", "typingSpeed", "uiSoundVolume"].map(key => localStorage.getItem(`citropy.${key}`))), ["0", "1", "160", "35"]);
    assert.ok(f.requests.some(event => event.t === "notifications.configure" && event.preferences.subagents === true));
    for (const width of [1440, 420]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const section of ["General", "Appearance", "Notifications", "Application"]) {
        if (width === 420 && !(await page.getByRole("button", { name: section, exact: true }).isVisible())) await page.getByRole("button", { name: "Toggle navigation", exact: true }).click();
        await page.getByRole("button", { name: section, exact: true }).click();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${section} at ${width}`);
        await page.screenshot({ path: `/tmp/citropy-settings-sections-${section.toLowerCase()}-${width}.png`, animations: "disabled" });
      }
    }
    await f.close();
  });

  await t.test("desktop subscriptions, pending actions and errors survive tab and environment changes", async () => {
    const f = await fixture();
    const { page } = f;
    const windowRequests = await page.evaluate(() => window.desktopRequests.filter(value => value === "windowState").length);
    assert.equal(await page.evaluate(() => window.desktopListenerCounts().windows), 1);
    await page.getByRole("button", { name: "Application", exact: true }).click();
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await page.getByRole("button", { name: "General", exact: true }).click();
    await page.getByRole("button", { name: "Application", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Reload", exact: true }).isDisabled(), true);
    await page.evaluate(() => window.changeEnvironment("remote"));
    await page.evaluate(() => window.settingsStore.setState({ development: true }));
    assert.equal(await page.getByRole("button", { name: "Reload", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Restart server", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Browser", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Computer use", exact: true }).count(), 0);
    await page.evaluate(() => window.pendingDesktopActions.shift().reject(new Error("Reload failed for this test")));
    await page.getByRole("alert").getByText("Reload failed for this test", { exact: true }).waitFor();
    await page.getByRole("button", { name: "General", exact: true }).click();
    await page.evaluate(() => window.publishDesktopUpdate("ready"));
    await page.getByRole("button", { name: "Application", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Restart", exact: true }).isDisabled(), true);
    await page.getByText("Use Restart & apply to install the downloaded update.", { exact: true }).waitFor();
    await page.evaluate(() => window.changeEnvironment("local"));
    await page.getByRole("alert").getByText("Reload failed for this test", { exact: true }).waitFor();
    await page.evaluate(() => window.publishDesktopUpdate("current"));
    await page.getByRole("button", { name: "Restart", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await page.evaluate(() => window.desktopRequests.includes("restart")), false);
    await page.getByRole("button", { name: "Restart", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Restart desktop", exact: true }).click();
    await page.waitForFunction(() => window.desktopRequests.includes("restart"));
    await page.evaluate(() => window.pendingDesktopActions.shift().resolve());
    assert.equal(await page.evaluate(() => window.desktopRequests.filter(value => value === "windowState").length), windowRequests);
    await page.evaluate(() => window.unmountSettings());
    assert.deepEqual(await page.evaluate(() => window.desktopListenerCounts()), { windows: 0, updates: 0 });
    await f.close();
  });

  await t.test("browser-only application actions retain confirmation and connection guards", async () => {
    const f = await fixture(false);
    const { page } = f;
    await page.getByRole("button", { name: "Application", exact: true }).click();
    await page.getByRole("button", { name: "Open desktop", exact: true }).click();
    await page.getByRole("button", { name: "Restart server", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Restart server", exact: true }).click();
    await page.waitForFunction(() => !window.settingsStore.getState().confirmation);
    assert.ok(f.requests.some(event => event.t === "desktop.open"));
    assert.ok(f.requests.some(event => event.t === "server.restart"));
    await page.evaluate(() => window.settingsStore.setState({ connected: false }));
    assert.equal(await page.getByRole("button", { name: "Open desktop", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Restart server", exact: true }).isDisabled(), true);
    await f.close();
  });
});
