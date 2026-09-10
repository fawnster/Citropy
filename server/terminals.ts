import { spawn, type IPty } from "node-pty";
import { env, platform } from "node:process";
import { bus } from "./bus.ts";

const sessions = new Map<string, IPty>();
const outputs = new Map<string, string>();
const directories = new Map<string, string>();

function shell(): string {
  if (platform === "win32") return env.COMSPEC ?? "powershell.exe";
  return env.SHELL ?? "/bin/bash";
}

export function open(termId: string, cwd: string, cols: number, rows: number, command?: string): void {
  if (sessions.has(termId)) {
    if (directories.get(termId) !== cwd) throw new Error("Terminal belongs to another workspace");
    return;
  }
  if (outputs.has(termId)) {
    if (directories.get(termId) !== cwd) throw new Error("Terminal belongs to another workspace");
    return;
  }
  const terminalEnv: NodeJS.ProcessEnv = {
    ...env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "Citropy",
    CLICOLOR: "1",
  };
  delete terminalEnv.NO_COLOR;
  delete terminalEnv.FORCE_COLOR;
  delete terminalEnv.CLICOLOR_FORCE;
  const program = shell();
  const args = command ? platform === "win32" ? /cmd\.exe$/i.test(program) ? ["/d", "/s", "/c", command] : ["-NoProfile", "-Command", command] : ["-c", command] : [];
  const pty = spawn(program, args, {
    name: "xterm-256color",
    cwd,
    cols: Math.max(cols, 20),
    rows: Math.max(rows, 5),
    env: terminalEnv as Record<string, string>,
  });
  outputs.set(termId, command ? `${command}\r\n` : "");
  directories.set(termId, cwd);
  sessions.set(termId, pty);
  pty.onData((data) => {
    if (sessions.get(termId) !== pty) return;
    outputs.set(termId, `${outputs.get(termId) ?? ""}${data}`.slice(-200_000));
    bus.emit({ t: "term.data", termId, data });
  });
  pty.onExit(({ exitCode }) => {
    if (sessions.get(termId) !== pty) return;
    sessions.delete(termId);
    outputs.set(termId, `${outputs.get(termId) ?? ""}\r\n[process exited with code ${exitCode}]\r\n`);
    bus.emit({ t: "term.exit", termId, code: exitCode });
  });
}

export function read(termId: string): string {
  return outputs.get(termId) ?? "";
}

export function write(termId: string, data: string): void {
  const session = sessions.get(termId);
  if (!session) throw new Error("This terminal has exited. Open a new terminal.");
  session.write(data);
}

export function resize(termId: string, cols: number, rows: number): void {
  try {
    sessions.get(termId)?.resize(Math.max(cols, 20), Math.max(rows, 5));
  } catch {
    /* pty already gone */
  }
}

export function close(termId: string): void {
  outputs.delete(termId);
  directories.delete(termId);
  const pty = sessions.get(termId);
  if (!pty) return;
  sessions.delete(termId);
  try {
    pty.kill();
  } catch {
    /* already dead */
  }
}

export function closeAll(): void {
  for (const id of [...sessions.keys()]) close(id);
  outputs.clear();
  directories.clear();
}
