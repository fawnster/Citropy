import { mkdir, open, readFile, readlink, realpath, stat, writeFile } from "node:fs/promises";
import { constants, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, parse } from "node:path";
import { dataRoot } from "./paths.ts";
import { directoryState, inside, sameDirectoryState } from "./files.ts";
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
  isAlive?: () => boolean,
): Promise<ToolImage[]> {
  const saved: ToolImage[] = [];
  const dir = join(root, threadId);
  for (const image of images.slice(0, maxImages)) {
    const extension = types[image.mime?.toLowerCase()];
    if (!extension || typeof image.data !== "string") continue;
    const body = Buffer.from(image.data, "base64");
    if (!body.length || body.length > maxBytes) continue;
    const id = randomUUID();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, `${id}.${extension}`), body, { mode: 0o600 });
    saved.push({ id, mime: image.mime.toLowerCase() });
  }
  if (saved.length && isAlive && !isAlive()) {
    rmSync(dir, { recursive: true, force: true });
    return [];
  }
  return saved;
}

export async function saveToolImageFile(
  threadId: string,
  path: string,
  isAlive: () => boolean,
): Promise<ToolImage> {
  const verifyDescriptorPath = process.platform === "linux";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!isAlive()) throw new Error("Conversation closed.");
    const directories = verifyDescriptorPath ? undefined : await directoryState(parse(path).root, dirname(path));
    if (directories === null) throw new Error("The image path changed. Try again.");
    const directory = verifyDescriptorPath
      ? await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      : undefined;
    try {
      if (directory && await readlink(`/proc/self/fd/${directory.fd}`) !== dirname(path))
        throw new Error("The image path changed. Try again.");
      const lookup = directory ? `/proc/self/fd/${directory.fd}/${basename(path)}` : path;
      const expected = await stat(lookup, { bigint: true });
      if (!expected.isFile()) throw new Error("Choose a regular image file.");
      if (expected.size > maxBytes) throw new Error("Images can be up to 8 MiB.");
      if (await realpath(lookup) !== path) throw new Error("The image path changed. Try again.");
      const file = await open(lookup, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let body: Buffer;
      try {
        const info = await file.stat({ bigint: true });
        if (!info.isFile() || info.dev !== expected.dev || info.ino !== expected.ino ||
            info.size !== expected.size || info.ctimeNs !== expected.ctimeNs || info.mtimeNs !== expected.mtimeNs)
          throw new Error("The image file changed. Try again.");
        if (verifyDescriptorPath && await readlink(`/proc/self/fd/${file.fd}`) !== path)
          throw new Error("The image path changed. Try again.");
        const buffer = Buffer.alloc(maxBytes + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > maxBytes) throw new Error("Images can be up to 8 MiB.");
        if (verifyDescriptorPath && await readlink(`/proc/self/fd/${file.fd}`) !== path)
          throw new Error("The image path changed. Try again.");
        const current = await file.stat({ bigint: true });
        if (current.size !== info.size || current.ctimeNs !== info.ctimeNs || current.mtimeNs !== info.mtimeNs) continue;
        body = buffer.subarray(0, length);
      } finally {
        await file.close();
      }
      if (directories && !(await sameDirectoryState(directories))) continue;
      const mime = body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
        : body[0] === 255 && body[1] === 216 && body[2] === 255 ? "image/jpeg"
        : ["GIF87a", "GIF89a"].includes(body.toString("latin1", 0, 6)) ? "image/gif"
        : body.toString("latin1", 0, 4) === "RIFF" && body.toString("latin1", 8, 12) === "WEBP" ? "image/webp"
        : undefined;
      if (!mime) throw new Error("Choose a PNG, JPEG, GIF, or WebP image.");
      if (!isAlive()) throw new Error("Conversation closed.");
      const [image] = await saveToolImages(threadId, [{ mime, data: body.toString("base64") }], isAlive);
      if (!image) throw new Error("Conversation closed.");
      return image;
    } finally {
      await directory?.close();
    }
  }
  throw new Error("The image path changed. Try again.");
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
