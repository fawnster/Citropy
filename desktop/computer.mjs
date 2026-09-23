import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { globalShortcut } from "electron";
import { openComputerIndicator } from "./computer-indicator.mjs";

const mac = process.platform === "darwin";
const helper = fileURLToPath(new URL(mac ? "./computer-mac" : "./computer-linux.py", import.meta.url));
const [program, programArgs] = mac ? [helper, []] : ["python3", [helper]];
const shortcut = mac ? "Control+Alt+Escape" : "CommandOrControl+Alt+Escape";
const shortcutName = mac ? "Control+Option+Escape" : "Ctrl+Alt+Escape";
let child;
let stopping;
let sequence = 0;
let generation = 0;
let notify = () => {};
let indicator;
let indicatorController;
let indicatorState;
const pending = new Map();

export function connectComputerEvents(callback) {
  notify = callback;
}

export function stopComputer(reason = "Computer control stopped.", error = false) {
  generation++;
  indicatorController?.abort();
  indicatorController = undefined;
  indicator?.close();
  indicator = undefined;
  indicatorState = undefined;
  const process = child;
  child = undefined;
  if (globalShortcut.isRegistered(shortcut)) globalShortcut.unregister(shortcut);
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
  pending.clear();
  if (process?.pid && process.exitCode === null && process.signalCode === null) {
    stopping = new Promise((resolve) => {
      const timer = setTimeout(() => process.kill("SIGKILL"), 1500);
      process.once("exit", () => { clearTimeout(timer); resolve(); });
      process.kill("SIGTERM");
    }).finally(() => { stopping = undefined; });
  }
  notify({ t: "computer.stopped", reason, error });
  return stopping ?? Promise.resolve();
}

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!child?.stdin.writable) return reject(new Error("Start a computer session first."));
    const id = ++sequence;
    const timer = setTimeout(() => stopComputer("Computer control timed out. Start a new session to continue.", true), method === "start" ? 125000 : method === "action" && params.action === "type" ? 80000 : 25000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

export async function computerRequest(method, params = {}) {
  if (method === "computer.stop") {
    await stopComputer();
    return;
  }
  if (method === "computer.capabilities") {
    if (!mac && process.platform !== "linux") return { available: false, platform: process.platform, backend: "unavailable", reason: "Computer use currently supports Linux and macOS desktops." };
    if (mac && !existsSync(helper)) return { available: false, platform: "darwin", backend: "unavailable", reason: "The macOS computer helper is missing. Start Citropy with npm run desktop to build it with the Xcode Swift compiler." };
    return new Promise((resolve) => {
      execFile(program, [...programArgs, "--probe"], { timeout: 10000, maxBuffer: 16000 }, (error, stdout) => {
        try { resolve(JSON.parse(stdout)); }
        catch { resolve({ available: false, platform: process.platform, backend: "unavailable", reason: error?.message || (mac ? "The macOS computer helper could not start." : "Install Python 3, PyGObject, and the desktop control libraries.") }); }
      });
    });
  }
  if (method === "computer.start") {
    if (stopping) await stopping;
    if (child) throw new Error("Another computer session is already open.");
    const revision = ++generation;
    const process = spawn(program, programArgs, { stdio: ["pipe", "pipe", "pipe"] });
    child = process;
    let buffer = "";
    let errorOutput = "";
    process.stderr.on("data", (data) => { errorOutput = (errorOutput + data).slice(-1000); });
    process.stdout.setEncoding("utf8");
    process.stdout.on("data", (data) => {
      buffer += data;
      if (buffer.length > 12 * 1024 * 1024) return stopComputer("The screen image exceeded the capture limit.", true);
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (revision !== generation) return;
        if (message.event === "closed") return stopComputer(message.reason, message.error === true);
        const entry = pending.get(message.id);
        if (!entry) continue;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(message.error));
        else entry.resolve(message.result);
      }
    });
    process.stdin.on("error", () => {});
    process.on("error", (error) => { if (revision === generation) stopComputer(error.message, true); });
    process.on("exit", () => { if (revision === generation) stopComputer(errorOutput.trim() || "Computer control ended unexpectedly. Start a new session to continue.", true); });
    try {
      const result = await send("start", params);
      if (revision !== generation) throw new Error("Computer control was stopped.");
      let registered = false;
      try { registered = globalShortcut.register(shortcut, () => stopComputer(`Stopped with ${shortcutName}.`)); } catch {}
      indicatorController = new AbortController();
      indicatorState = { displays: result.displays, control: Boolean(params.control), paused: false, shortcut: registered, language: params.language };
      const opened = await openComputerIndicator(indicatorState, (action, error) => {
        if (revision !== generation) return;
        if (action === "stop") void stopComputer(error || "Stopped from the screen indicator.", Boolean(error));
        else void computerRequest("computer.pause", { paused: action === "pause" }).catch(error => stopComputer(error.message, true));
      }, indicatorController.signal);
      if (revision !== generation) { opened.close(); throw new Error("Computer control was stopped."); }
      indicator = opened;
      return { ...result, shortcut: registered };
    } catch (error) {
      if (revision === generation) stopComputer(error.message, true);
      throw error;
    }
  }
  if (method === "computer.screenshot") return send("screenshot", params);
  if (method === "computer.pause") {
    const revision = generation;
    if (params.paused) child?.kill("SIGUSR1");
    const result = await send("pause", params);
    if (revision === generation) {
      indicatorState = { ...indicatorState, paused: Boolean(params.paused) };
      indicator?.update(indicatorState);
      notify({ t: "computer.paused", paused: Boolean(params.paused) });
    }
    return result;
  }
  if (method === "computer.action") return send("action", params);
  throw new Error("Unknown computer operation");
}
