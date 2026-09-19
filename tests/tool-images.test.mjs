import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = await mkdtemp(join(tmpdir(), "citropy-tool-images-"));
process.env.CITROPY_DATA_DIR = join(root, "data");
const { saveToolImages, serveToolImage, removeToolImages } = await import("../server/tool-images.ts");
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function capture() {
  const call = { status: 0, headers: {}, body: undefined };
  return {
    call,
    res: {
      writeHead(status, headers) {
        call.status = status;
        Object.assign(call.headers, headers);
        return this;
      },
      end(body) {
        call.body = body;
      },
    },
  };
}

test("tool images save, serve, reject unknown types, and clear with their conversation", async (t) => {
  t.after(async () => rm(root, { recursive: true, force: true }));
  const saved = await saveToolImages("thr_images", [
    { mime: "image/png", data: png.toString("base64") },
    { mime: "text/plain", data: png.toString("base64") },
    { mime: "image/png", data: "" },
  ]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].mime, "image/png");

  const hit = capture();
  await serveToolImage({ method: "GET" }, hit.res, new URLSearchParams({ threadId: "thr_images", id: saved[0].id }));
  assert.equal(hit.call.status, 200);
  assert.equal(hit.call.headers["content-type"], "image/png");
  assert.deepEqual(Buffer.from(hit.call.body), png);
  assert.match(hit.call.headers["content-security-policy"], /sandbox/);

  const download = capture();
  await serveToolImage({ method: "GET" }, download.res, new URLSearchParams({ threadId: "thr_images", id: saved[0].id, download: "1" }));
  assert.match(download.call.headers["content-disposition"], /^attachment/);

  const missing = capture();
  await serveToolImage({ method: "GET" }, missing.res, new URLSearchParams({ threadId: "thr_images", id: "00000000-0000-0000-0000-000000000000" }));
  assert.equal(missing.call.status, 404);

  const invalid = capture();
  await serveToolImage({ method: "GET" }, invalid.res, new URLSearchParams({ threadId: "../escape", id: saved[0].id }));
  assert.equal(invalid.call.status, 404);

  removeToolImages("thr_images");
  const cleared = capture();
  await serveToolImage({ method: "GET" }, cleared.res, new URLSearchParams({ threadId: "thr_images", id: saved[0].id }));
  assert.equal(cleared.call.status, 404);
});

test("tool images saved for a removed conversation leave nothing behind", async (t) => {
  t.after(async () => rm(root, { recursive: true, force: true }));
  const saved = await saveToolImages("thr_gone", [{ mime: "image/png", data: png.toString("base64") }], () => false);
  assert.deepEqual(saved, []);
  assert.equal(existsSync(join(root, "data", "tool-images", "thr_gone")), false);
  const kept = await saveToolImages("thr_alive", [{ mime: "image/png", data: png.toString("base64") }], () => true);
  assert.equal(kept.length, 1);
  assert.equal(existsSync(join(root, "data", "tool-images", "thr_alive", `${kept[0].id}.png`)), true);
});
