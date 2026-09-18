import { mkdir, readFile, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { dataRoot } from "./paths.ts";
import { inside } from "./files.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ToolImage } from "../shared/protocol.ts";

const root = join(dataRoot, "tool-images");
const maxImages = 6;
const maxBytes = 8 * 1024 * 1024;
const types: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function removeToolImages(threadId: string): void {
  rmSync(join(root, threadId), { recursive: true, force: true });
}

export async function saveToolImages(
  threadId: string,
  images: Array<{ mime: string; data: string }>,
): Promise<ToolImage[]> {
  const saved: ToolImage[] = [];
  for (const image of images.slice(0, maxImages)) {
    const extension = types[image.mime?.toLowerCase()];
    if (!extension || typeof image.data !== "string") continue;
    const body = Buffer.from(image.data, "base64");
    if (!body.length || body.length > maxBytes) continue;
    const id = randomUUID();
    const dir = join(root, threadId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, `${id}.${extension}`), body, { mode: 0o600 });
    saved.push({ id, mime: image.mime.toLowerCase() });
  }
  return saved;
}

export async function serveToolImage(
  req: IncomingMessage,
  res: ServerResponse,
  params: URLSearchParams,
): Promise<void> {
  const threadId = params.get("threadId") ?? "";
  const id = params.get("id") ?? "";
  if (!/^[\w-]{1,120}$/.test(threadId) || !/^[0-9a-f-]{36}$/.test(id)) {
    res.writeHead(404).end();
    return;
  }
  for (const [mime, extension] of Object.entries(types)) {
    const path = inside(root, join(threadId, `${id}.${extension}`));
    if (!path) break;
    let body: Buffer;
    try {
      body = await readFile(path);
    } catch {
      continue;
    }
    res.writeHead(200, {
      "content-type": mime,
      "content-length": body.length,
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'; img-src data:",
      "content-disposition": `${params.has("download") ? "attachment" : "inline"}; filename="image.${extension}"`,
    });
    if (req.method === "HEAD") res.end();
    else res.end(body);
    return;
  }
  res.writeHead(404, { "cache-control": "private, max-age=60" }).end();
}
