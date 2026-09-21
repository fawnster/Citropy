import { spawn, type IPty } from "node-pty";
import { stopProcess, waitForStoppedProcesses } from "./providers/process.ts";
import type { PanelTab } from "../shared/workbench.ts";

export interface TerminalSession {
  id: string;
  cwd: string;
  command?: string;
  panel?: PanelTab;
  output: string;
  offset?: number;
  running: boolean;
  code?: number;
}

export type TerminalEvent = { type: "data"; id: string; data: string; offset?: number } | { type: "exit"; id: string; code: number };

export class TerminalHost {
  #sessions = new Map<string, TerminalSession & { pty?: IPty; pending: string; timer?: NodeJS.Timeout; blocked: Set<string> }>();
  #emit: (event: TerminalEvent) => void;

  constructor(emit: (event: TerminalEvent) => void) { this.#emit = emit; }

  list(): TerminalSession[] {
    return [...this.#sessions.values()].map(({ pty, pending, timer, blocked, ...session }) => ({ ...session }));
  }

  open(input: { id: string; cwd: string; cols: number; rows: number; command?: string; panel?: PanelTab; env?: Record<string, string> }): TerminalSession {
    const existing = this.#sessions.get(input.id);
    if (existing) {
      if (existing.cwd !== input.cwd) throw new Error("Terminal belongs to another workspace.");
      return this.list().find(session => session.id === input.id)!;
    }
    if (!input.id || input.id.length > 200 || !input.cwd || !Number.isFinite(input.cols) || !Number.isFinite(input.rows)) throw new Error("Invalid terminal options.");
    if (this.#sessions.size >= 64) throw new Error("Close an existing terminal before opening more than 64 terminals.");
    const program = process.platform === "win32" ? process.env.COMSPEC ?? "powershell.exe" : process.env.SHELL ?? "/bin/bash";
    const args = input.command ? process.platform === "win32" ? /cmd\.exe$/i.test(program) ? ["/d", "/s", "/c", input.command] : ["-NoProfile", "-Command", input.command] : ["-c", input.command] : process.platform === "win32" ? [] : ["-l"];
    const env = { ...process.env, ...input.env, TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "Citropy", CLICOLOR: "1" };
    for (const key of ["NO_COLOR", "FORCE_COLOR", "CLICOLOR_FORCE", "CITROPY_REMOTE_TOKEN", "CITROPY_DESKTOP_TOKEN"]) delete (env as NodeJS.ProcessEnv)[key];
    const pty = spawn(program, args, { cwd: input.cwd, cols: Math.max(20, Math.min(input.cols, 1000)), rows: Math.max(5, Math.min(input.rows, 1000)), env: env as Record<string, string>, name: "xterm-256color" });
    const session = { id: input.id, cwd: input.cwd, command: input.command, panel: input.panel, output: input.command ? `${input.command}\r\n` : "", offset: input.command ? input.command.length + 2 : 0, running: true, pty: pty as IPty | undefined, pending: "", timer: undefined as NodeJS.Timeout | undefined, blocked: new Set<string>() };
    this.#sessions.set(input.id, session);
    const flush = () => {
      session.timer = undefined;
      if (!session.pending) return;
      let length = Math.min(session.pending.length, 16_384);
      const last = session.pending.charCodeAt(length - 1);
      if (last >= 0xd800 && last <= 0xdbff) length--;
      const data = session.pending.slice(0, length);
      session.pending = session.pending.slice(length);
      this.#emit({ type: "data", id: input.id, data, offset: session.offset - session.pending.length });
      if (session.pending.length) session.timer = setTimeout(flush, 16);
      if (session.pending.length < 32_768 && !session.blocked.size) session.pty?.resume();
    };
    pty.onData(data => {
      if (this.#sessions.get(input.id) !== session) return;
      session.output = (session.output + data).slice(-200_000);
      session.offset += data.length;
      session.pending += data;
      if (session.pending.length > 65_536) session.pty?.pause();
      if (!session.timer) session.timer = setTimeout(flush, 16);
    });
    pty.onExit(({ exitCode }) => {
      if (this.#sessions.get(input.id) !== session) return;
      session.pty = undefined;
      const finish = () => {
        if (this.#sessions.get(input.id) !== session) return;
        if (session.pending.length) { setTimeout(finish, 20); return; }
        Object.assign(session, { code: exitCode, running: false });
        session.output = (session.output + `\r\n[process exited with code ${exitCode}]\r\n`).slice(-200_000);
        this.#emit({ type: "exit", id: input.id, code: exitCode });
      };
      finish();
    });
    return this.list().find(session => session.id === input.id)!;
  }

  write(id: string, data: string): void {
    const pty = this.#sessions.get(id)?.pty;
    if (!pty) throw new Error("This terminal has exited. Open a new terminal.");
    if (typeof data !== "string" || data.length > 128 * 1024) throw new Error("Terminal input is too large.");
    pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    this.#sessions.get(id)?.pty?.resize(Math.max(20, Math.min(cols, 1000)), Math.max(5, Math.min(rows, 1000)));
  }

  flow(id: string, client: string, paused: boolean): void {
    const session = this.#sessions.get(id);
    if (!session) return;
    if (paused) session.blocked.add(client); else session.blocked.delete(client);
    if (session.blocked.size) session.pty?.pause();
    else if (session.pending.length < 65_536) session.pty?.resume();
  }

  release(client: string): void { for (const id of this.#sessions.keys()) this.flow(id, client, false); }

  async close(id: string): Promise<void> {
    const session = this.#sessions.get(id);
    if (!session) return;
    this.#sessions.delete(id);
    clearTimeout(session.timer);
    session.pending = "";
    if (session.pty) { stopProcess(session.pty, true); await waitForStoppedProcesses(); }
  }

  async closeAll(): Promise<void> { await Promise.all([...this.#sessions.keys()].map(id => this.close(id))); }
}
