import { open, readdir, stat, realpath } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
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

/**
 * Read a contained regular file as a UTF-8 preview, capped at 512 KiB of input.
 * Append a truncation notice when more data exists; return null for denied or failed reads.
 */
export async function read(root: string, path: string): Promise<string | null> {
  const abs = inside(root, path);
  if (!abs) return null;
  try {
    // Capture the identity before resolving containment. If the path is swapped after
    // validation, the opened descriptor must still match this exact filesystem object.
    const expected = await stat(abs);
    if (!expected.isFile()) return null;
    const canonicalRoot = await realpath(root);
    const canonical = await realpath(abs);
    if (!inside(canonicalRoot, canonical)) return null;
    const file = await open(canonical, "r");
    try {
      const info = await file.stat();
      if (!info.isFile() || info.dev !== expected.dev || info.ino !== expected.ino) return null;
      // One lookahead byte detects truncation without ever reading the entire file.
      // Loop because a successful read is allowed to return fewer bytes than requested.
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const truncated = length > MAX_BYTES;
      const bytes = buffer.subarray(0, Math.min(length, MAX_BYTES));
      // Do not flush an incomplete trailing UTF-8 sequence at the truncation boundary.
      const text = truncated ? new StringDecoder("utf8").write(bytes) : bytes.toString("utf8");
      return truncated ? `${text}\n… truncated at 512 KB` : text;
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}
