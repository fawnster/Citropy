import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { stat } from "node:fs/promises";

const run = promisify(execFile);
let pending: Promise<string | null> | null = null;

export function chooseFolder(title = "Open workspace in Citropy"): Promise<string | null> {
  if (pending) return pending;
  pending = run("kdialog", ["--getexistingdirectory", homedir(), "--title", title], { maxBuffer: 64 * 1024 })
    .then(async ({ stdout }) => {
      const path = stdout.replace(/\r?\n$/, "");
      if (!path) return null;
      if (!(await stat(path)).isDirectory()) throw new Error("Choose a folder for the workspace.");
      return path;
    })
    .catch((error: Error & { code?: string | number }) => {
      if (error.code === 1) return null;
      if (error.code === "ENOENT") throw new Error("The system folder chooser (kdialog) is not installed.");
      throw error;
    })
    .finally(() => { pending = null; });
  return pending;
}
