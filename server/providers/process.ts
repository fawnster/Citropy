import type { ChildProcess } from "node:child_process";

const stopping = new Map<ChildProcess, Promise<void>>();

export function stopProcess(child: ChildProcess): void {
  if (child.exitCode != null || child.signalCode != null || stopping.has(child)) return;
  let complete!: () => void;
  stopping.set(child, new Promise<void>((resolve) => { complete = resolve; }));
  const finish = () => {
    clearTimeout(timer);
    child.off("exit", finish);
    child.off("close", finish);
    stopping.delete(child);
    complete();
  };
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  timer.unref();
  child.once("exit", finish);
  child.once("close", finish);
  child.kill("SIGTERM");
}

export async function waitForStoppedProcesses(): Promise<void> {
  await Promise.all(stopping.values());
}
