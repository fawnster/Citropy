import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { app } from "electron";

export function openComputerIndicator(state, onCommand, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Computer control was stopped."));
    const directory = mkdtempSync(join(tmpdir(), "citropy-indicator-"));
    const env = { ...process.env, CITROPY_INDICATOR_DATA: directory };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.execPath, [
      ...(process.platform === "linux" && env.DISPLAY && !env.WAYLAND_DISPLAY && env.XDG_SESSION_TYPE !== "wayland" ? ["--ozone-platform=x11"] : []),
      ...(!app.isPackaged ? [fileURLToPath(new URL("./entry.mjs", import.meta.url))] : []),
      "--computer-indicator",
    ], { env, stdio: ["pipe", "pipe", "pipe"] });
    let closed = false;
    let ready = false;
    let errorText = "";
    const update = (value) => {
      if (!closed && child.stdin.writable) child.stdin.write(`${JSON.stringify(value)}\n`);
    };
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      child.stdin.end();
      if (child.exitCode !== null || child.signalCode !== null) return;
      const kill = setTimeout(() => child.kill("SIGKILL"), 1500);
      kill.unref();
      child.once("exit", () => clearTimeout(kill));
    };
    const failed = (message) => {
      if (closed) return;
      close();
      if (ready) onCommand("stop", message);
      else reject(new Error(message));
    };
    const timer = setTimeout(() => failed("The computer-use indicator could not open."), 10_000);
    const abort = () => { close(); if (!ready) reject(new Error("Computer control was stopped.")); };
    signal.addEventListener("abort", abort, { once: true });
    child.stderr.on("data", data => { errorText = (errorText + data).slice(-1000); });
    child.stdin.on("error", () => failed("The computer-use indicator disconnected."));
    child.on("error", error => failed(error.message));
    child.on("exit", () => failed(errorText.trim() || "The computer-use indicator closed."));
    child.on("close", () => { void rm(directory, { recursive: true, force: true }).catch(() => {}); });
    createInterface({ input: child.stdout }).on("line", line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (closed) return;
      if (message.ready && !ready) {
        ready = true;
        clearTimeout(timer);
        resolve({ update, close });
      } else if (["pause", "resume", "stop"].includes(message.action)) onCommand(message.action);
    });
    update(state);
  });
}
