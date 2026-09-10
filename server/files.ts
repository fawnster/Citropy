import { readdir, readFile, stat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FileEntry } from "../shared/protocol.ts";

const IGNORED = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "target",
  ".venv",
  "__pycache__",
  ".turbo",
  ".cache",
]);

const MAX_BYTES = 512 * 1024;

export function inside(root: string, path: string): string | null {
  const abs = resolve(root, path);
  const rel = relative(root, abs);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return null;
  return abs;
}

export async function tree(root: string, sub = ""): Promise<FileEntry[]> {
  const dir = inside(root, sub);
  if (!dir) return [];
  if (!inside(await realpath(root), await realpath(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const out: FileEntry[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
    if (IGNORED.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    out.push({
      name: entry.name,
      path: relative(root, abs),
      dir: entry.isDirectory(),
    });
  }
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return out;
}

export async function read(root: string, path: string): Promise<string | null> {
  const abs = inside(root, path);
  if (!abs) return null;
  try {
    if (!inside(await realpath(root), await realpath(abs))) return null;
    const info = await stat(abs);
    if (!info.isFile()) return null;
    if (info.size > MAX_BYTES) {
      const buffer = await readFile(abs);
      return `${buffer.subarray(0, MAX_BYTES).toString("utf8")}\n… truncated at 512 KB`;
    }
    return await readFile(abs, "utf8");
  } catch {
    return null;
  }
}
