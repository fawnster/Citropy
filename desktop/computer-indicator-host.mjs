import { app, BrowserWindow, ipcMain, screen } from "electron";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

app.setName("Citropy computer use");
app.setPath("userData", process.env.CITROPY_INDICATOR_DATA);
const windows = new Map();
let state;
let closing = false;
let ready = false;
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);

async function render() {
  if (!state || closing) return;
  const available = screen.getAllDisplays();
  const shared = state.displays ?? [];
  const positioned = shared.length > 0 && shared.every(display => Number.isFinite(display.x) && Number.isFinite(display.y));
  const matches = positioned ? available.filter(display => shared.some(source =>
    source.x < display.bounds.x + display.bounds.width && source.x + source.width > display.bounds.x &&
    source.y < display.bounds.y + display.bounds.height && source.y + source.height > display.bounds.y,
  )) : available;
  const targets = matches.length ? matches : available;
  for (const [id, window] of windows) {
    if (!targets.some(display => display.id === id)) {
      windows.delete(id);
      window.destroy();
    }
  }
  for (const display of targets) {
    let window = windows.get(display.id);
    const area = display.workArea;
    const width = Math.min(420, Math.max(1, area.width - 16));
    if (!window) {
      window = new BrowserWindow({
        title: "Citropy computer use", x: Math.round(area.x + (area.width - width) / 2), y: area.y + 8,
        width, height: 48, frame: false, transparent: true, show: false,
        resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
        focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true,
        webPreferences: { preload: fileURLToPath(new URL("./computer-indicator-preload.cjs", import.meta.url)), sandbox: true, contextIsolation: true, nodeIntegration: false, partition: "computer-indicator" },
      });
      windows.set(display.id, window);
      window.setAlwaysOnTop(true, "screen-saver");
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      window.setContentProtection(true);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", event => event.preventDefault());
      window.webContents.on("render-process-gone", () => emit({ action: "stop" }));
      window.on("close", event => { if (!closing) { event.preventDefault(); emit({ action: "stop" }); } });
      await window.loadFile(fileURLToPath(new URL("./computer-indicator.html", import.meta.url)));
      if (closing || window.isDestroyed()) continue;
      window.webContents.send("computer-indicator:state", state);
      window.showInactive();
    } else {
      const bounds = window.getBounds();
      window.setBounds({ x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - width))), y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - 48))), width, height: 48 });
      window.webContents.send("computer-indicator:state", state);
    }
  }
  if (!ready && !closing) { ready = true; emit({ ready: true }); }
}

ipcMain.on("computer-indicator:action", (event, action) => {
  if (closing || event.senderFrame !== event.sender.mainFrame || ![...windows.values()].some(window => window.webContents === event.sender)) return;
  if (["pause", "resume", "stop"].includes(action)) emit({ action });
});
let queue = app.whenReady().then(() => { app.dock?.hide(); });
const update = () => { queue = queue.then(render).catch(() => emit({ action: "stop" })); };
createInterface({ input: process.stdin }).on("line", line => {
  try { state = JSON.parse(line); } catch { return; }
  update();
});
app.whenReady().then(() => {
  screen.on("display-added", update);
  screen.on("display-removed", update);
  screen.on("display-metrics-changed", update);
});
process.stdin.on("end", () => { closing = true; app.quit(); });
app.on("before-quit", () => { closing = true; });
app.on("window-all-closed", () => { if (closing) app.quit(); });
