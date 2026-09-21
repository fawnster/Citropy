import { execFile, type ChildProcess } from "node:child_process";
import type { IPty } from "node-pty";

/**
 * Windows has no process groups, and provider CLIs run behind cmd.exe / powershell.exe launchers,
 * so `child.kill()` would orphan the real agent. `taskkill /T` ends the whole tree.
 */
function killTreeOnWindows(pid: number | undefined, force: boolean): void {
  if (!pid) return;
  execFile("taskkill", ["/pid", String(pid), "/T", ...(force ? ["/F"] : [])], { windowsHide: true }, () => {});
}

const stopping = new Map<ChildProcess | IPty, Promise<void>>();

export function stopProcess(child: ChildProcess | IPty, processGroup = false): void {
  if (stopping.has(child)) return;
  let ended = "onExit" in child ? false : child.exitCode != null || child.signalCode != null;
  const group = processGroup && process.platform !== "win32" ? child.pid : undefined;
  const alive = () => {
    if (!group) return !ended;
    try { process.kill(-group, 0); return true; }
    catch { return false; }
  };
  if (!alive()) return;
  const signal = (value: NodeJS.Signals) => {
    if (processGroup && process.platform === "win32" && !("onExit" in child)) {
      killTreeOnWindows(child.pid, value === "SIGKILL");
      if (value === "SIGKILL") child.kill();
      return;
    }
    if (!group) { child.kill(value); return; }
    try { process.kill(-group, value); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(value); }
  };
  let complete!: () => void;
  let escalated = false;
  stopping.set(child, new Promise<void>((resolve) => { complete = resolve; }));
  const finish = () => {
    clearTimeout(timer);
    if (subscription) subscription.dispose();
    else if ("off" in child) {
      child.off("exit", exited);
      child.off("close", exited);
    }
    stopping.delete(child);
    complete();
  };
  const exited = () => {
    ended = true;
    if (!group || escalated || !alive()) finish();
  };
  const timer = setTimeout(() => {
    escalated = true;
    signal("SIGKILL");
    if (group && ended) finish();
  }, 2000);
  if (!group) timer.unref();
  const subscription = "onExit" in child ? child.onExit(exited) : undefined;
  if ("once" in child) {
    child.once("exit", exited);
    child.once("close", exited);
  }
  signal("SIGTERM");
}

export async function waitForStoppedProcesses(): Promise<void> {
  await Promise.all(stopping.values());
}
