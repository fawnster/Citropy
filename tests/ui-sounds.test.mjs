import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("..", import.meta.url));
const sounds = join(root, "web/src/assets/sounds");

test("every sound recipe points at a file, and every file is used", () => {
  const source = readFileSync(join(root, "web/src/lib/ui-sound.ts"), "utf8");
  const referenced = new Set(
    [...source.matchAll(/\.\.\/assets\/sounds\/([\w-]+\.ogg)/g)].map(
      (match) => match[1],
    ),
  );
  assert.ok(referenced.size >= 6, `found ${referenced.size} referenced sounds`);
  for (const name of referenced) assert.ok(existsSync(join(sounds, name)), name);
  assert.deepEqual(
    readdirSync(sounds)
      .filter((name) => name.endsWith(".ogg"))
      .sort(),
    [...referenced].sort(),
  );
});

const markup = `<main>
  <button id="plain">Save</button>
  <button id="disabled" disabled>Save</button>
  <button id="inert" aria-disabled="true">Later</button>
  <label class="setting-row" id="switch-row"><span><strong id="switch-label">Switch</strong></span><input id="switch" class="setting-switch" type="checkbox" role="switch"></label>
  <label class="setting-row" id="on-row"><input id="on" type="checkbox" role="switch" checked></label>
  <label class="setting-row" id="preview-row"><input id="preview-switch" type="checkbox"><button id="preview" type="button">Preview</button></label>
  <div role="tab" id="tab">Tab</div>
  <div role="menuitem" id="menu-item">Rename</div>
  <a href="#" id="link">Docs</a>
  <button id="opening" type="button" aria-expanded="false">Inspector</button>
  <button id="closing" type="button" aria-expanded="true">Inspector</button>
  <button id="silent" type="button" data-ui-sound="off">Preview</button>
  <div id="silent-ancestor" data-ui-sound="off"><button id="silent-child" type="button">Send</button></div>
  <div class="xterm"><div id="terminal-text">$ npm test</div></div>
  <textarea id="notes"></textarea>
  <input id="range" type="range">
  <span id="plain-text">hello</span>
</main>`;

test("clicks play the right sound and preview buttons leave switches alone", { timeout: 120_000 }, async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), "citropy-ui-sounds-"));
  const server = await createServer({
    configFile: false,
    cacheDir,
    root,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, watch: null },
  });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  });

  const base = server.resolvedUrls.local[0];
  const page = await browser.newPage();
  await page.route("**/*", (route) =>
    route.request().resourceType() === "document"
      ? route.fulfill({ contentType: "text/html", body: markup })
      : route.continue(),
  );
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);

  const result = await page.evaluate(async (origin) => {
    const sound = await import(`${origin}web/src/lib/ui-sound.ts`);
    const { clickSoundFor } = await import(`${origin}web/src/lib/use-ui-sounds.ts`);
    const { useApp, applyEvents } = await import(`${origin}web/src/lib/store.ts`);

    const started = [];
    const gains = [];
    let resumes = 0;
    let contexts = 0;
    class FakeAudioContext {
      constructor() {
        contexts += 1;
        this.state = "suspended";
        this.currentTime = 0;
        this.destination = { connect: (node) => node };
      }
      createGain() {
        const node = {
          gain: {
            value: 0,
            setTargetAtTime: (value) => {
              node.gain.value = value;
            },
          },
          connect: (destination) => destination,
        };
        gains.push(node);
        return node;
      }
      createBufferSource() {
        return {
          buffer: null,
          detune: { value: 0 },
          connect: (node) => node,
          start: (at) => started.push(at),
        };
      }
      decodeAudioData() {
        return Promise.resolve({ duration: 0.01 });
      }
      resume() {
        resumes += 1;
        this.state = "running";
        return Promise.resolve();
      }
    }
    window.AudioContext = FakeAudioContext;

    const names = ["click", "nav", "toggle-on", "toggle-off", "send", "copy", "done", "attention", "error"];
    const previews = {};
    for (const name of names) {
      const before = started.length;
      await sound.previewUiSound(name);
      previews[name] = started.length - before;
    }
    const all = { volume: 60, interfaceSounds: true, alertSounds: true };
    const levels = {};
    for (const [name, value] of Object.entries({ muted: 0, half: 50, full: 100 })) {
      sound.configureUiSounds({ ...all, volume: value });
      levels[name] = gains[0].gain.value;
    }
    sound.configureUiSounds(all);

    const counted = (run) => {
      const before = started.length;
      run();
      return started.length - before;
    };
    const gated = {};
    sound.configureUiSounds({ ...all, interfaceSounds: false });
    gated.sendWhileInterfaceOff = counted(() => sound.playUiSound("send"));
    gated.clickWhileInterfaceOff = counted(() => sound.playUiSound("click"));
    gated.alertWhileInterfaceOff = counted(() => sound.playUiSound("done"));
    sound.configureUiSounds({ ...all, alertSounds: false });
    gated.alertWhileAlertsOff = counted(() => sound.playUiSound("attention"));
    gated.sendWhileAlertsOff = counted(() => sound.playUiSound("send"));
    sound.configureUiSounds({ volume: 60, interfaceSounds: false, alertSounds: false });
    const before = started.length;
    await sound.previewUiSound("click");
    gated.previewWhileAllOff = started.length - before;
    sound.configureUiSounds(all);

    const classify = (id) => clickSoundFor(document.getElementById(id));
    const classes = {
      button: classify("plain"),
      disabled: classify("disabled"),
      inert: classify("inert"),
      switch: classify("switch"),
      switchLabel: classify("switch-label"),
      checked: classify("on"),
      terminal: classify("terminal-text"),
      textarea: classify("notes"),
      range: classify("range"),
      tab: classify("tab"),
      menuItem: classify("menu-item"),
      link: classify("link"),
      opening: classify("opening"),
      closing: classify("closing"),
      silent: classify("silent"),
      silentChild: classify("silent-child"),
      text: classify("plain-text"),
      preview: classify("preview"),
    };

    const state = {
      ...useApp.getState(),
      uiAlertSounds: true,
      notifications: [],
      toasts: [],
      readingThreadId: null,
    };
    const notification = (level) => ({
      id: `n-${level}`,
      kind: "chat",
      level,
      title: "Response finished",
      text: "workspace",
      createdAt: 1,
      read: false,
      target: { view: "chat", projectId: "workspace", threadId: "thread" },
    });
    const alerts = {};
    for (const [name, events] of Object.entries({
      question: [{ t: "question.request", request: { id: "q1", threadId: "thread", questions: [] } }],
      permission: [{ t: "permission.request", request: { id: "p1", threadId: "thread" } }],
      success: [{ t: "notification.add", notification: notification("success") }],
      error: [{ t: "notification.add", notification: notification("error") }],
      info: [{ t: "notification.add", notification: { ...notification("info"), kind: "update" } }],
    })) {
      const before = started.length;
      applyEvents(state, events);
      alerts[name] = started.length - before;
    }
    return { previews, classes, alerts, gated, levels, resumes, contexts };
  }, base);

  assert.deepEqual(errors, []);
  assert.deepEqual(result.previews, {
    click: 1,
    nav: 1,
    "toggle-on": 1,
    "toggle-off": 1,
    send: 1,
    copy: 1,
    done: 1,
    attention: 1,
    error: 1,
  });
  assert.equal(result.contexts, 1);
  assert.equal(result.resumes, 1);
  assert.equal(result.levels.muted, 0);
  assert.equal(result.levels.full, 1);
  assert.ok(Math.abs(result.levels.half - 0.5 ** 1.6) < 1e-6, result.levels.half);
  assert.deepEqual(result.gated, {
    sendWhileInterfaceOff: 0,
    clickWhileInterfaceOff: 0,
    alertWhileInterfaceOff: 1,
    alertWhileAlertsOff: 0,
    sendWhileAlertsOff: 1,
    previewWhileAllOff: 1,
  });
  assert.deepEqual(result.classes, {
    button: "click",
    disabled: null,
    inert: null,
    switch: "toggle-on",
    switchLabel: "toggle-on",
    checked: "toggle-off",
    terminal: null,
    textarea: null,
    range: null,
    tab: "nav",
    menuItem: "nav",
    link: "nav",
    opening: "click",
    closing: "click",
    silent: null,
    silentChild: null,
    text: null,
    preview: "click",
  });
  assert.deepEqual(result.alerts, {
    question: 1,
    permission: 1,
    success: 1,
    error: 1,
    info: 0,
  });

  await page.click("#preview");
  await page.click("#switch-label");
  const toggled = await page.evaluate(() => ({
    preview: document.getElementById("preview-switch").checked,
    row: document.getElementById("switch").checked,
  }));
  assert.deepEqual(toggled, { preview: false, row: true });
});
