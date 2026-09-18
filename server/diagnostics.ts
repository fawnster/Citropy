import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpus, freemem, totalmem, loadavg } from "node:os";
import { desktopRequest } from "./desktop.ts";
import { store } from "./store.ts";
import { panelList } from "./panels.ts";
import { browserStates } from "./browser.ts";
import { servicePid } from "./terminals.ts";
import { protocolLog } from "./providers/events.ts";
import type { DiagnosticReport } from "../shared/features.ts";

const run = promisify(execFile);

export async function diagnostics(): Promise<DiagnosticReport> {
  const memory = process.memoryUsage();
  let processes: DiagnosticReport["processes"] = [];
  if (process.platform !== "win32") {
    const scan = run("ps", ["-axo", "pid=,ppid=,%cpu=,rss=,comm="], {
      timeout: 5000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const { stdout } = await scan;
    const all = stdout.split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line);
      return match
        ? [
            {
              pid: Number(match[1]),
              parent: Number(match[2]),
              cpu: Number(match[3]),
              memory: Number(match[4]) * 1024,
              name: match[5]!,
            },
          ]
        : [];
    });
    const terminalPid = servicePid();
    const included = new Set([process.pid, ...(terminalPid ? [terminalPid] : [])]);
    for (let changed = true; changed; ) {
      changed = false;
      for (const entry of all)
        if (included.has(entry.parent) && !included.has(entry.pid)) {
          included.add(entry.pid);
          changed = true;
        }
    }
    processes = all
      .filter(
        (entry) => included.has(entry.pid) && entry.pid !== scan.child.pid,
      )
      .sort((a, b) => b.cpu - a.cpu);
  }
  const desktop = await desktopRequest<DiagnosticReport["processes"]>(
    "diagnostics",
  ).catch(() => []);
  const allProcesses = new Map(processes.map((entry) => [entry.pid, entry]));
  for (const entry of desktop) allProcesses.set(entry.pid, entry);
  const cpu = process.cpuUsage();
  if (!allProcesses.has(process.pid))
    allProcesses.set(process.pid, {
      pid: process.pid,
      parent: process.ppid,
      name: "Citropy server",
      cpu: (cpu.user + cpu.system) / Math.max(process.uptime(), 1) / 10000,
      memory: memory.rss,
    });
  processes = [...allProcesses.values()].sort((a, b) => b.cpu - a.cpu);
  return {
    protocol: protocolLog(),
    sampledAt: Date.now(),
    uptime: process.uptime(),
    system: {
      memoryTotal: totalmem(),
      memoryFree: freemem(),
      cores: cpus().length,
      load: loadavg(),
    },
    server: {
      pid: process.pid,
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
    },
    processes,
    conversations: store.threads.size,
    running: [...store.threads.values()].filter((thread) => thread.running)
      .length,
    terminals: panelList().filter((panel) => panel.kind === "terminal").length,
    browsers: browserStates().length,
  };
}
