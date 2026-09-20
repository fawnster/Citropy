export function revealDesktopWindow(window, { maximized = false } = {}) {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  if (maximized && !window.isMaximized()) window.maximize();
  window.focus();
}

export function createSecondInstanceFocus(getWindow) {
  let pending = false;
  const focus = () => {
    const window = getWindow();
    if (!window || window.isDestroyed()) {
      pending = true;
      return;
    }
    revealDesktopWindow(window);
  };
  return {
    focus,
    flush() {
      if (!pending) return;
      pending = false;
      focus();
    },
  };
}
