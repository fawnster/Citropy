import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

export function desktopDiagnostics(directory) {
  const file = join(directory, "desktop.log");
  return (event, { version, electron, platform, packaged, childPid, code, signal, reason, type } = {}) => {
    try {
      const line = `${JSON.stringify({ time: new Date().toISOString(), pid: process.pid, event, version, electron, platform, packaged, childPid, code, signal, reason, type })}\n`;
      const bytes = Buffer.byteLength(line);
      if (bytes > 4096) return;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (existsSync(file)) {
        chmodSync(file, 0o600);
        if (statSync(file).size + bytes > 128 * 1024) renameSync(file, `${file}.1`);
      }
      appendFileSync(file, line, { mode: 0o600 });
    } catch {}
  };
}
