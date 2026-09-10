import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import { join } from "node:path";
import { spawn } from "node:child_process";
import childProcess from "node:child_process";
import { chromium } from "playwright";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { syncBuiltinESMExports } from "node:module";

const originalSpawn = spawn;

async function waitFor(check) {
  for (let i = 0; i < 300; i++) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for a result");
}

test("shared workspace tools and panels", { timeout: 60000 }, async (t) => {
  const directory = fs.mkdtempSync(join(os.tmpdir(), "citropy-workbench-"));
  const originalHome = os.homedir;
  const environment = {
    DISPLAY: process.env.DISPLAY,
    NO_COLOR: process.env.NO_COLOR,
    CITROPY_PORT: process.env.CITROPY_PORT,
    CITROPY_DESKTOP_DATA: process.env.CITROPY_DESKTOP_DATA,
  };
  const originalShell = process.env.SHELL;
  const display = spawn(
    "Xvfb",
    ["-displayfd", "3", "-screen", "0", "1600x1000x24"],
    { stdio: ["ignore", "ignore", "ignore", "pipe"] },
  );
  const [displayNumber] = await once(display.stdio[3], "data");
  process.env.DISPLAY = `:${String(displayNumber).trim()}`;
  process.env.CITROPY_DESKTOP_DATA = join(directory, "desktop");
  process.env.SHELL = "/bin/bash";
  process.env.NO_COLOR = "1";
  os.homedir = () => directory;
  let endpoint;
  let desktopErrors = "";
  let browserConnection;
  childProcess.spawn = (command, args, options) => {
    const electron = command.endsWith("/electron");
    const process = originalSpawn(
      command,
      electron
        ? ["--ozone-platform=x11", "--remote-debugging-port=0", ...args]
        : args,
      options,
    );
    if (electron)
      process.stderr.on("data", (data) => {
        desktopErrors = (desktopErrors + String(data)).slice(-12000);
        endpoint =
          /DevTools listening on (ws:\/\/\S+)/.exec(String(data))?.[1] ??
          endpoint;
      });
    return process;
  };
  syncBuiltinESMExports();
  const pageRequests = [];
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/mcp/"))
      void handleMcp(req.url.split("/")[2], req, res);
    else {
      if (req.headers["sec-fetch-dest"] === "document")
        pageRequests.push({ url: req.url, headers: req.headers });
      res.writeHead(200, { "content-type": "text/html" });
      const html =
        "<!doctype html><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Browser fixture</title><div style=\"position:fixed;right:0;top:0;width:40px;height:40px;background:#16b819\"></div><h1>Shared browser</h1><label>Name <input id=\"name\"></label><button onclick=\"document.querySelector('output').textContent='Hello '+document.querySelector('input').value\">Greet</button><button onclick=\"confirm('Continue?')\">Confirm</button><output></output><div style=\"height:1400px;background:#d02020\"></div><div style=\"height:1400px;background:#2050d0\"></div>";
      const navigation = /Android.*Mobile/.test(req.headers["user-agent"] ?? "") && req.headers["sec-ch-ua-mobile"] === "?1"
        ? "Mobile navigation"
        : "Desktop navigation";
      const device = `<nav id="device-ui">${navigation}</nav><script>
        window.initialDevice = {
          userAgent: navigator.userAgent,
          mobile: navigator.userAgentData?.mobile,
          platform: navigator.userAgentData?.platform,
          touch: navigator.maxTouchPoints,
          coarse: matchMedia('(pointer: coarse)').matches,
          hover: matchMedia('(hover: hover)').matches
        };
        window.pointerKinds = [];
        addEventListener('pointerdown', event => window.pointerKinds.push(event.pointerType));
      </script>`;
      res.end((req.url === "/legacy" ? html.replace(/<meta[^>]*>/, "") : html) + device);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  process.env.CITROPY_PORT = String(server.address().port);
  const { store, Store } = await import("../server/store.ts");
  const { handleMcp, workspaceTools } = await import("../server/mcp.ts");
  const { connectTools, authorizeTools } =
    await import("../server/mcp-access.ts");
  const { panelList, openPanel, closePanel } =
    await import("../server/panels.ts");
  const browser = await import("../server/browser.ts");
  const terminals = await import("../server/terminals.ts");
  const { pendingRequests, answer } = await import("../server/permissions.ts");
  const { runtimeFor, disposeRuntime, disposeAll } =
    await import("../server/runtime.ts");
  const { providers } = await import("../server/providers/index.ts");
  const { attachDesktop, authorizeDesktop, desktopRequest } =
    await import("../server/desktop.ts");
  const wss = new WebSocketServer({
    server,
    path: "/socket",
    verifyClient: ({ req }) =>
      authorizeDesktop(new URL(req.url, url).searchParams.get("desktop")),
  });
  wss.on("connection", attachDesktop);
  const sessions = new Map();
  for (const provider of Object.values(providers)) {
    provider.detect = async () => ({ available: true });
    provider.models = [{ id: "test", label: "Test", efforts: ["high"] }];
    provider.start = (options) => {
      const session = {
        options,
        stopped: false,
        disposed: false,
        send() {},
        interrupt() {
          this.stopped = true;
        },
        dispose() {
          this.disposed = true;
        },
      };
      sessions.set(options.threadId, session);
      return session;
    };
  }
  const projectPath = join(directory, "workspace");
  const otherPath = join(directory, "other");
  fs.mkdirSync(projectPath);
  fs.mkdirSync(otherPath);
  fs.writeFileSync(join(projectPath, "hello.txt"), "Workspace file");
  const project = store.openProject(projectPath);
  const otherProject = store.openProject(otherPath);
  const parent = store.createThread({
    projectId: project.id,
    provider: "codex",
    model: "test",
    effort: "high",
    title: "Parent",
    permissionMode: "bypass",
  });
  const other = store.createThread({
    projectId: otherProject.id,
    provider: "codex",
    model: "test",
    title: "Other",
    permissionMode: "bypass",
  });
  const credentials = connectTools(parent.id);
  let sequence = 0;
  async function rpc(
    method,
    params,
    headers = credentials.headers,
    id = parent.id,
  ) {
    const response = await fetch(`${url}/mcp/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    });
    return {
      status: response.status,
      body: response.status === 200 ? await response.json() : null,
    };
  }
  async function tool(name, args = {}, id = parent.id) {
    const result = await rpc(
      "tools/call",
      { name, arguments: args },
      connectTools(id).headers,
      id,
    );
    assert.equal(result.status, 200);
    return result.body.result;
  }
  t.after(async () => {
    disposeAll();
    terminals.closeAll();
    await browser.closeBrowsers();
    await browserConnection?.close();
    store.flush();
    await new Promise((resolve) => server.close(resolve));
    os.homedir = originalHome;
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    display.kill();
    if (originalShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
    await new Promise((resolve) => setTimeout(resolve, 450));
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await t.test(
    "MCP negotiates, lists tools and rejects unauthorized callers",
    async () => {
      const changes = openPanel(
        project.id,
        "changes",
        parent.id,
        "first-window",
      );
      assert.equal(
        openPanel(project.id, "changes", parent.id, "second-window").id,
        changes.id,
      );
      closePanel(changes.id);
      assert.equal(
        (await rpc("initialize", { protocolVersion: "2025-06-18" })).body.result
          .protocolVersion,
        "2025-06-18",
      );
      assert.equal(
        (await rpc("tools/list")).body.result.tools.length,
        workspaceTools.length + 1,
      );
      assert.equal((await rpc("tools/list", {}, {})).status, 401);
      assert.equal(
        (await rpc("tools/list", {}, credentials.headers, other.id)).status,
        401,
      );
      assert.equal(
        (
          await rpc(
            "tools/list",
            {},
            { ...credentials.headers, origin: "https://example.com" },
          )
        ).status,
        403,
      );
      assert.equal((await rpc("unsupported")).body.error.code, -32601);
      assert.equal((await tool("missing_tool")).isError, true);
      assert.equal(
        (await tool("workspace_read", { path: "hello.txt" })).content[0].text,
        "Workspace file",
      );
      assert.notEqual(
        (await tool("workspace_read", { path: "../outside.txt" })).content[0]
          .text,
        "Outside",
      );
    },
  );

  await t.test(
    "browser control and manual interaction share the same page, with tab isolation",
    async () => {
      const opened = await tool("browser_open", { url });
      assert.equal(opened.isError, false, `${opened.content[0].text}\n${desktopErrors}`);
      const first = JSON.parse(opened.content[0].text);
      const second = JSON.parse(
        (await tool("browser_open", { url })).content[0].text,
      );
      browserConnection = await chromium.connectOverCDP(
        await waitFor(() => endpoint),
      );
      for (const page of browserConnection.contexts()[0].pages())
        page.on("dialog", () => {});
      const shell = await waitFor(async () => {
        for (const page of browserConnection.contexts()[0].pages())
          if (await page.evaluate(() => Boolean(window.citropyDesktop)))
            return page;
      });
      await shell.evaluate(() =>
        window.citropyDesktop.onBrowserSelect(({ id }) =>
          window.citropyDesktop.browserBounds(
            id,
            { x: 200, y: 100, width: 1000, height: 800 },
            true,
          ),
        ),
      );
      await shell.evaluate(
        (id) =>
          window.citropyDesktop.browserBounds(
            id,
            { x: 200, y: 100, width: 1000, height: 800 },
            true,
          ),
        first.id,
      );
      assert.notEqual(first.id, second.id);
      let snapshot = await tool("browser_snapshot", { tabId: first.id });
      assert.match(snapshot.content[0].text, /Shared browser/);
      assert.equal(snapshot.isError, false);
      assert.equal(snapshot.content[1].type, "image");
      await browser.browserAction(first.id, {
        action: "type",
        role: "textbox",
        name: "Name",
        text: "Citropy",
      });
      const page = await waitFor(async () => {
        for (const page of browserConnection.contexts()[0].pages())
          if ((await page.locator("#name").inputValue().catch(() => "")) === "Citropy") return page;
      });
      assert.equal(
        (
          await tool("browser_action", {
            tabId: first.id,
            action: "click",
            role: "button",
            name: "Greet",
          })
        ).isError,
        false,
      );
      snapshot = await tool("browser_snapshot", { tabId: first.id });
      assert.match(snapshot.content[0].text, /Hello Citropy/);
      assert.deepEqual(await page.evaluate(() => [innerWidth, innerHeight]), [1920, 1080]);
      for (const [width, height] of [[480, 700], [900, 500]]) {
        await shell.evaluate(({ id, width, height }) => window.citropyDesktop.browserBounds(id, { x: 200, y: 100, width, height }, true), { id: first.id, width, height });
        await waitFor(() => Math.abs(browser.browserStates().find((tab) => tab.id === first.id)?.scale - Math.min(width / 1920, height / 1080)) < 0.001);
        assert.deepEqual(await page.evaluate(() => [innerWidth, innerHeight]), [1920, 1080]);
      }
      const resized = await tool("browser_action", { tabId: first.id, action: "resize", width: 390, height: 844, mobile: true });
      assert.equal(resized.isError, false, resized.content[0].text);
      assert.deepEqual(await page.evaluate(() => [innerWidth, innerHeight, screen.width, screen.height]), [390, 844, 390, 844]);
      const resizedState = JSON.parse(resized.content[0].text);
      assert.equal(resizedState.width, 390);
      assert.equal(resizedState.height, 844);
      assert.equal(resizedState.mobile, true);
      const mobileDevice = await page.evaluate(() => window.initialDevice);
      assert.match(mobileDevice.userAgent, /Android.*Mobile/);
      assert.deepEqual({ ...mobileDevice, userAgent: undefined }, {
        userAgent: undefined, mobile: true, platform: "Android", touch: 5, coarse: true, hover: false,
      });
      assert.equal(await page.locator("#device-ui").textContent(), "Mobile navigation");
      assert.equal(pageRequests.at(-1).headers["sec-ch-ua-mobile"], "?1");
      assert.equal(pageRequests.at(-1).headers["sec-ch-ua-platform"], '"Android"');
      await tool("browser_action", { tabId: second.id, action: "navigate", url: `${url}/other` });
      assert.doesNotMatch(pageRequests.at(-1).headers["user-agent"], /Android.*Mobile/);
      assert.notEqual(pageRequests.at(-1).headers["sec-ch-ua-mobile"], "?1");
      assert.equal(await page.evaluate(() => navigator.userAgentData.mobile), true);
      await tool("browser_action", { tabId: first.id, action: "type", role: "textbox", name: "Name", text: "Touch" });
      await tool("browser_action", { tabId: first.id, action: "click", role: "button", name: "Greet" });
      assert.equal(await page.locator("output").textContent(), "Hello Touch");
      assert.equal(await page.evaluate(() => window.pointerKinds.at(-1)), "touch");
      await page.evaluate(() => {
        document.querySelector("output").textContent = "Waiting for touch";
        window.pointerKinds = [];
      });
      const touchButton = await page.getByRole("button", { name: "Greet" }).boundingBox();
      const touchScale = browser.browserStates().find((tab) => tab.id === first.id).scale;
      const origin = await shell.evaluate(() => [screenX, screenY]);
      const touchX = origin[0] + 200 + Math.round((900 - Math.round(390 * touchScale)) / 2) + (touchButton.x + touchButton.width / 2) * touchScale;
      const touchY = origin[1] + 100 + (touchButton.y + touchButton.height / 2) * touchScale;
      childProcess.execFileSync("/usr/bin/xdotool", ["mousemove", "--sync", String(Math.round(touchX)), String(Math.round(touchY)), "click", "1"], { env: { ...process.env, DISPLAY: process.env.DISPLAY } });
      await waitFor(async () => await page.locator("output").textContent() === "Hello Touch");
      assert.equal(await page.evaluate(() => window.pointerKinds.at(-1)), "touch");
      const count = pageRequests.length;
      await tool("browser_action", { tabId: first.id, action: "resize", width: 400, height: 850 });
      assert.equal(JSON.parse((await tool("browser_action", { tabId: first.id, action: "resize", width: 390, height: 844 })).content[0].text).mobile, true);
      assert.equal(await page.locator("output").textContent(), "Hello Touch");
      assert.equal(pageRequests.length, count);
      snapshot = await tool("browser_snapshot", { tabId: first.id });
      const dimensions = await page.evaluate(async (image) => {
        const blob = await (await fetch(`data:${image.mimeType};base64,${image.data}`)).blob();
        const bitmap = await createImageBitmap(blob);
        const dimensions = [bitmap.width, bitmap.height];
        bitmap.close();
        return dimensions;
      }, snapshot.content[1]);
      assert.deepEqual(dimensions, [390, 844]);
      const mobileScroll = await tool("browser_action", { tabId: first.id, action: "scroll", x: 0, y: 300 });
      assert.equal(mobileScroll.isError, false, mobileScroll.content[0].text);
      await waitFor(async () => await page.evaluate(() => scrollY) > 200);
      await tool("browser_action", { tabId: first.id, action: "scroll", x: 0, y: -300 });
      await waitFor(async () => await page.evaluate(() => scrollY) < 5);
      assert.equal((await tool("browser_action", { tabId: first.id, action: "resize", width: 0, height: 900 })).isError, true);
      await tool("browser_action", { tabId: first.id, action: "resize", width: 1920, height: 1080, mobile: false });
      assert.deepEqual(await page.evaluate(() => [innerWidth, innerHeight]), [1920, 1080]);
      const desktopDevice = await page.evaluate(() => window.initialDevice);
      assert.doesNotMatch(desktopDevice.userAgent, /Android.*Mobile/);
      assert.equal(desktopDevice.mobile, false);
      assert.equal(desktopDevice.touch, 0);
      assert.equal(desktopDevice.coarse, false);
      assert.equal(desktopDevice.hover, true);
      assert.equal(await page.locator("#device-ui").textContent(), "Desktop navigation");
      assert.notEqual(pageRequests.at(-1).headers["sec-ch-ua-mobile"], "?1");
      await page.getByRole("textbox", { name: "Name" }).fill("Shared input");
      const button = await page.getByRole("button", { name: "Greet" }).boundingBox();
      const scale = browser.browserStates().find((tab) => tab.id === first.id).scale;
      await page.mouse.click((button.x + button.width / 2) * scale, (button.y + button.height / 2) * scale);
      assert.match(
        (await tool("browser_snapshot", { tabId: first.id })).content[0].text,
        /Hello Shared input/,
      );
      await page.getByRole("textbox", { name: "Name" }).fill("Coordinates");
      await tool("browser_action", { tabId: first.id, action: "click", x: button.x + button.width / 2, y: button.y + button.height / 2 });
      assert.match((await tool("browser_snapshot", { tabId: first.id })).content[0].text, /Hello Coordinates/);
      await tool("browser_action", { tabId: first.id, action: "scroll", x: 0, y: 600 });
      await page.waitForFunction(() => scrollY >= 500);
      await page.evaluate(() => new Promise((resolve) => {
        let last = scrollY;
        let stable = 0;
        const check = () => {
          stable = scrollY === last ? stable + 1 : 0;
          last = scrollY;
          if (stable === 4) resolve();
          else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      }));
      assert.ok(Math.abs(await page.evaluate(() => scrollY) - 600) < 3);
      await page.evaluate(() => scrollTo(0, 1700));
      snapshot = await tool("browser_snapshot", { tabId: first.id });
      const captured = await page.evaluate(async (image) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:${image.mimeType};base64,${image.data}`)).blob());
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d");
        context.drawImage(bitmap, 0, 0);
        const result = { width: bitmap.width, height: bitmap.height, pixels: [[20, 20], [1900, 1060]].map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data)) };
        bitmap.close();
        return result;
      }, snapshot.content[1]);
      assert.equal(captured.width, 1920);
      assert.equal(captured.height, 1080);
      assert.ok(captured.pixels.every((pixel) => pixel[2] > 180 && pixel[0] < 50), JSON.stringify(captured));
      assert.equal(await page.evaluate(() => scrollY), 1700);
      await page.evaluate(() => scrollTo(0, 0));
      assert.deepEqual(
        await page.evaluate(() => [
          typeof window.require,
          typeof window.citropyDesktop,
        ]),
        ["undefined", "undefined"],
      );
      await tool("browser_action", {
        tabId: first.id,
        action: "type",
        role: "textbox",
        name: "Name",
        text: "Replace me",
      });
      await tool("browser_action", {
        tabId: first.id,
        action: "press",
        key: "Control+A",
      });
      await tool("browser_action", {
        tabId: first.id,
        action: "type",
        text: "Keyboard input",
      });
      assert.equal(
        await page.getByRole("textbox", { name: "Name" }).inputValue(),
        "Keyboard input",
      );
      assert.doesNotMatch(
        (await tool("browser_snapshot", { tabId: second.id })).content[0].text,
        /Hello Citropy/,
      );
      assert.equal(
        (await tool("browser_snapshot", { tabId: first.id }, other.id)).isError,
        true,
      );
      await tool("browser_action", { tabId: first.id, action: "resize", width: 390, height: 844, mobile: true });
      const legacy = await tool("browser_action", { tabId: first.id, action: "navigate", url: `${url}/legacy` });
      assert.equal(legacy.isError, false, legacy.content[0].text);
      assert.equal(JSON.parse(legacy.content[0].text).url, `${url}/legacy`);
      await page.waitForURL(`${url}/legacy`);
      assert.ok(await page.evaluate(() => innerWidth > 390));
      await tool("browser_action", { tabId: first.id, action: "type", role: "textbox", name: "Name", text: "Mobile" });
      await tool("browser_action", { tabId: first.id, action: "click", role: "button", name: "Greet" });
      snapshot = await tool("browser_snapshot", { tabId: first.id });
      assert.match(snapshot.content[0].text, /Hello Mobile/);
      const edge = await page.evaluate(async (image) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:${image.mimeType};base64,${image.data}`)).blob());
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d");
        context.drawImage(bitmap, 0, 0);
        const pixel = Array.from(context.getImageData(bitmap.width - 10, 10, 1, 1).data);
        bitmap.close();
        return pixel;
      }, snapshot.content[1]);
      assert.ok(edge[1] > 150 && edge[0] < 50, JSON.stringify(edge));
      const confirmation = await tool("browser_action", {
        tabId: first.id,
        action: "click",
        role: "button",
        name: "Confirm",
      });
      assert.equal(confirmation.isError, false, confirmation.content[0].text);
      const dialog = await waitFor(
        () =>
          browser.browserStates().find((tab) => tab.id === first.id)?.dialog,
      );
      assert.equal(dialog.message, "Continue?");
      assert.equal(
        (
          await tool("browser_action", {
            tabId: first.id,
            action: "dialog",
            accept: false,
          })
        ).isError,
        false,
      );
      const saved = browser.browserStates().find((tab) => tab.id === first.id);
      await desktopRequest("browser.close", { id: first.id });
      await desktopRequest("browser.open", { ...saved, url: `${url}/restored` });
      const restored = await waitFor(() => browserConnection.contexts()[0].pages().find((page) => page.url() === `${url}/restored`));
      assert.equal(await restored.locator("#device-ui").textContent(), "Mobile navigation");
      assert.equal(await restored.evaluate(() => window.initialDevice.mobile), true);
      assert.equal(await restored.evaluate(() => window.initialDevice.touch), 5);
      await restored.evaluate(() => { document.cookie = "profileTest=workspace; path=/"; });
      const profiles = await desktopRequest("profiles.profiles", { projectId: project.id, method: "GET" });
      assert.ok(profiles.profiles[0].cookies > 0);
      const createdProfile = await desktopRequest("profiles.profiles", { projectId: project.id, method: "POST", name: "Isolated test profile" });
      const isolated = JSON.parse((await tool("browser_open", { url: `${url}/profile-test` })).content[0].text);
      assert.equal(isolated.profileId, createdProfile.selected);
      const isolatedPage = await waitFor(() => browserConnection.contexts().flatMap((context) => context.pages()).find((page) => page.url() === `${url}/profile-test`));
      assert.equal(await isolatedPage.evaluate(() => document.cookie.includes("profileTest")), false);
      await tool("browser_close", { tabId: isolated.id });
      await desktopRequest("profiles.profiles", { projectId: project.id, method: "DELETE", id: createdProfile.selected });
      const metrics = await desktopRequest("diagnostics");
      assert.ok(metrics.length > 1);
      assert.ok(metrics.every((entry) => entry.memory >= 0));
      await tool("browser_close", { tabId: first.id });
      assert.deepEqual(
        browser.browserStates().map((tab) => tab.id),
        [second.id],
      );
      assert.equal(
        (await tool("browser_snapshot", { tabId: second.id })).isError,
        false,
      );
      await tool("browser_close", { tabId: second.id });
      const interrupted = openPanel(project.id, "browser", parent.id);
      const opening = browser.openBrowser(
        project.id,
        interrupted.id,
        parent.id,
        url,
      );
      await waitFor(() =>
        browser.browserStates().some((tab) => tab.id === interrupted.id),
      );
      await Promise.all([
        opening,
        browser.browserAction(interrupted.id, {
          action: "navigate",
          url: `${url}/next`,
        }),
      ]);
      assert.equal(
        browser.browserStates().find((tab) => tab.id === interrupted.id).url,
        `${url}/next`,
      );
      await browser.closeBrowser(interrupted.id);
    },
  );

  await t.test(
    "permissions deny execution and Plan mode cannot bypass them",
    async () => {
      store.patchThread(parent.id, { permissionMode: "manual" });
      const pending = tool("terminal_open");
      const request = await waitFor(() => pendingRequests()[0]);
      answer(request.id, "deny");
      assert.equal((await pending).isError, true);
      assert.equal(
        panelList().filter((panel) => panel.kind === "terminal").length,
        0,
      );
      store.patchThread(parent.id, { permissionMode: "plan" });
      assert.equal((await tool("terminal_open")).isError, true);
      store.patchThread(parent.id, { permissionMode: "bypass" });
    },
  );

  await t.test(
    "terminals retain state when reattached and close independently",
    async () => {
      const first = JSON.parse((await tool("terminal_open")).content[0].text);
      const second = JSON.parse((await tool("terminal_open")).content[0].text);
      await tool("terminal_write", {
        tabId: first.tabId,
        text: "export CITROPY_TEST_VALUE=kept\n",
      });
      terminals.open(first.tabId, projectPath, 90, 25);
      await tool("terminal_write", {
        tabId: first.tabId,
        text: "printf 'result:%s' \"$CITROPY_TEST_VALUE\"\n",
      });
      await waitFor(() => terminals.read(first.tabId).includes("result:kept"));
      await tool("terminal_write", {
        tabId: first.tabId,
        text: 'printf \'color-env:%s:%s:%s\' "${NO_COLOR-unset}" "$TERM" "$COLORTERM"\n',
      });
      await waitFor(() =>
        terminals
          .read(first.tabId)
          .includes("color-env:unset:xterm-256color:truecolor"),
      );
      await tool("terminal_write", {
        tabId: first.tabId,
        text: "printf '\\033[32mgreen-output\\033[0m\\n'\n",
      });
      await waitFor(() =>
        terminals.read(first.tabId).includes("\u001b[32mgreen-output\u001b[0m"),
      );
      assert.equal(
        (await tool("terminal_read", { tabId: first.tabId }, other.id)).isError,
        true,
      );
      terminals.close(first.tabId);
      closePanel(first.tabId);
      await tool("terminal_write", {
        tabId: second.tabId,
        text: "printf 'still-open\\n'\n",
      });
      await waitFor(() => terminals.read(second.tabId).includes("still-open"));
      const third = openPanel(project.id, "terminal");
      assert.notEqual(third.title, second.title);
      terminals.close(second.tabId);
      closePanel(second.tabId);
      closePanel(third.id);
      terminals.open("exited", projectPath, 80, 24);
      terminals.write("exited", "exit 0\n");
      await waitFor(() => terminals.read("exited").includes("process exited"));
      assert.throws(() => terminals.open("exited", otherPath, 80, 24), /another workspace/);
      terminals.closeAll();
      assert.equal(terminals.read("exited"), "");
    },
  );

  await t.test(
    "delegation inherits permissions, persists and cancels descendants",
    async () => {
      store.patchThread(parent.id, { permissionMode: "plan" });
      const child = JSON.parse(
        (
          await tool("subagent_start", {
            title: "Review",
            task: "Read the workspace",
          })
        ).content[0].text,
      );
      const childSession = sessions.get(child.id);
      assert.equal(childSession.options.permissionMode, "plan");
      assert.equal(childSession.options.effort, "high");
      assert.match(childSession.options.mcp.url, new RegExp(child.id));
      assert.equal((await tool("terminal_open", {}, child.id)).isError, true);
      assert.equal(
        (
          await tool(
            "subagent_send",
            { id: child.id, text: "Another task" },
            other.id,
          )
        ).isError,
        true,
      );
      const waiting = tool("subagent_wait", { id: child.id, timeoutMs: 1000 });
      childSession.options.emit({
        type: "block.start",
        blockId: "answer",
        block: "text",
      });
      childSession.options.emit({
        type: "block.delta",
        blockId: "answer",
        text: "Review complete",
      });
      childSession.options.emit({ type: "turn.end" });
      assert.equal(JSON.parse((await waiting).content[0].text).running, false);
      store.flush();
      assert.equal(new Store().threads.get(child.id).parentThreadId, parent.id);
      await tool("subagent_send", { id: child.id, text: "Check again" });
      runtimeFor(parent.id).stop();
      assert.equal(childSession.stopped, true);
      assert.equal(store.threads.get(child.id).running, false);
      const token = connectTools(child.id).headers.Authorization;
      disposeRuntime(parent.id);
      assert.equal(childSession.disposed, true);
      assert.equal(authorizeTools(child.id, token), false);
      store.removeThread(parent.id);
      assert.equal(store.threads.has(child.id), false);
    },
  );
});
