import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSecondInstanceFocus,
  revealDesktopWindow,
} from "../desktop/window-reveal.mjs";

function fakeWindow(flags = {}) {
  const calls = [];
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
  };
  return window;
}

test("a maximized window is shown before it is maximized so Wayland can map it", () => {
  const window = fakeWindow();
  revealDesktopWindow(window, { maximized: true });
  assert.deepEqual(window.calls, ["show", "maximize", "focus"]);
});

test("a second launch before the window exists is applied once it does", () => {
  let window;
  const second = createSecondInstanceFocus(() => window);
  second.focus();
  assert.equal(window, undefined);
  window = fakeWindow({ minimized: true });
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
  const second = createSecondInstanceFocus(() => window);
  second.focus();
  assert.deepEqual(window.calls, ["restore", "show", "focus"]);
  second.flush();
  assert.deepEqual(window.calls, ["restore", "show", "focus"]);
});
