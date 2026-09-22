import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSecondInstanceFocus,
  prepareInitialWindowReveal,
  revealDesktopWindow,
} from "../desktop/window-reveal.mjs";

function fakeWindow(flags = {}) {
  const calls = [];
  const listeners = new Map();
  const window = {
    calls,
    destroyed: false,
    minimized: Boolean(flags.minimized),
    maximized: Boolean(flags.maximized),
    isDestroyed() {
      return this.destroyed;
    },
    isMinimized() {
      return this.minimized;
    },
    isMaximized() {
      return this.maximized;
    },
    restore() {
      calls.push("restore");
      this.minimized = false;
    },
    show() {
      calls.push("show");
    },
    maximize() {
      calls.push("maximize");
      this.maximized = true;
    },
    focus() {
      calls.push("focus");
    },
    once(event, listener) {
      listeners.set(event, listener);
    },
    removeListener(event, listener) {
      if (listeners.get(event) === listener) listeners.delete(event);
    },
    emit(event) {
      const listener = listeners.get(event);
      listeners.delete(event);
      listener?.();
    },
  };
  return window;
}

test("a maximized window is shown before it is maximized so Wayland can map it", () => {
  const window = fakeWindow();
  revealDesktopWindow(window, { maximized: true });
  assert.deepEqual(window.calls, ["show", "maximize", "focus"]);
});

test("a second launch before the window exists is applied once it does", () => {
  let focus;
  const second = createSecondInstanceFocus(() => focus);
  second.focus();
  const window = fakeWindow({ minimized: true });
  focus = () => revealDesktopWindow(window);
  second.flush();
  assert.deepEqual(window.calls, ["restore", "show", "focus"]);
});

test("a normal window is shown and focused without maximizing", () => {
  const window = fakeWindow();
  revealDesktopWindow(window);
  assert.deepEqual(window.calls, ["show", "focus"]);
});

test("an already maximized window is not maximized again", () => {
  const window = fakeWindow({ maximized: true });
  revealDesktopWindow(window, { maximized: true });
  assert.deepEqual(window.calls, ["show", "focus"]);
});

test("a destroyed window is left alone", () => {
  const window = fakeWindow();
  window.destroyed = true;
  revealDesktopWindow(window, { maximized: true });
  assert.deepEqual(window.calls, []);
});

test("a second launch after the window exists focuses it immediately", () => {
  const window = fakeWindow({ minimized: true });
  const second = createSecondInstanceFocus(
    () => () => revealDesktopWindow(window),
  );
  second.focus();
  assert.deepEqual(window.calls, ["restore", "show", "focus"]);
  second.flush();
  assert.deepEqual(window.calls, ["restore", "show", "focus"]);
});

test("Linux reveals a saved maximized window only once", () => {
  const window = fakeWindow();
  const focus = prepareInitialWindowReveal(window, {
    maximized: true,
    platform: "linux",
  });
  assert.deepEqual(window.calls, ["show", "maximize", "focus"]);
  window.maximized = false;
  focus();
  assert.deepEqual(window.calls, ["show", "maximize", "focus", "show", "focus"]);
});

test("other platforms wait until the window is ready before revealing it", () => {
  const window = fakeWindow();
  prepareInitialWindowReveal(window, { maximized: true, platform: "win32" });
  assert.deepEqual(window.calls, []);
  window.emit("ready-to-show");
  assert.deepEqual(window.calls, ["show", "maximize", "focus"]);
});

test("focusing before readiness cancels the delayed initial reveal", () => {
  const window = fakeWindow();
  const focus = prepareInitialWindowReveal(window, {
    maximized: true,
    platform: "darwin",
  });
  focus();
  assert.deepEqual(window.calls, ["show", "maximize", "focus"]);
  window.maximized = false;
  window.calls.length = 0;
  window.emit("ready-to-show");
  assert.deepEqual(window.calls, []);
});
