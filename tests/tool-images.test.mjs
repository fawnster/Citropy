import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

const root = await mkdtemp(join(tmpdir(), "citropy-tool-images-"));
process.env.CITROPY_DATA_DIR = join(root, "data");
const { saveToolImages, saveToolImageFile, serveToolImage, removeToolImages } = await import("../server/tool-images.ts");
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

test("published image reads handle short reads and close their descriptors", async t => {
  const fixture = await mkdtemp(join(tmpdir(), "citropy-image-read-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(fixture, "image.png");
  await fs.writeFile(path, png);
  const original = fs.open;
  const handles = [];
  let reads = 0;
  let closed = false;
  fs.open = async (...args) => {
    const file = await original(...args);
    handles.push(file);
    if (basename(args[0]) !== "image.png") return file;
    if (process.platform === "linux") assert.ok(args[1] & constants.O_NOCTTY);
    const read = file.read.bind(file);
    const close = file.close.bind(file);
    file.read = (buffer, offset, length, position) => { reads++; return read(buffer, offset, Math.min(3, length), position); };
    file.close = async () => { closed = true; await close(); };
    return file;
  };
  syncBuiltinESMExports();
  t.after(() => { fs.open = original; syncBuiltinESMExports(); });
  const image = await saveToolImageFile("thr_published", path, () => true);
  assert.ok(reads > 1);
  assert.equal(closed, true);
  assert.equal(handles.length, process.platform === "linux" ? 2 : 1);
  assert.ok(handles.every(file => file.fd === -1));
  assert.deepEqual(await fs.readFile(join(root, "data", "tool-images", "thr_published", `${image.id}.png`)), png);
});

test("published images reject canonical-path changes and never read a substituted file", async t => {
  const fixture = await mkdtemp(join(tmpdir(), "citropy-image-race-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const path = join(fixture, "image.png");
  const other = join(fixture, "other.png");
  await fs.writeFile(path, png);
  await fs.writeFile(other, png);
  await fs.symlink(other, join(fixture, "link.png"));
  await assert.rejects(saveToolImageFile("thr_race", join(fixture, "link.png"), () => true),
    process.platform === "linux" ? { code: "ELOOP" } : /path changed/);
  const original = fs.open;
  let read = false;
  let closed = false;
  fs.open = async (...args) => {
    if (basename(args[0]) !== "image.png") return original(...args);
    const file = await original(other, args[1]);
    const close = file.close.bind(file);
    file.read = async () => { read = true; throw new Error("Must not read a substituted file"); };
    file.close = async () => { closed = true; await close(); };
    return file;
  };
  syncBuiltinESMExports();
  t.after(() => { fs.open = original; syncBuiltinESMExports(); });
  await assert.rejects(saveToolImageFile("thr_race", path, () => true),
    process.platform === "linux" ? /path changed/ : /file changed/);
  assert.equal(read, false);
  assert.equal(closed, true);
});

test("published images reread after metadata changes and discard rejected bytes", async t => {
  const fixture = await mkdtemp(join(tmpdir(), "citropy-image-sibling-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(fixture, "workspace");
  await fs.mkdir(folder);
  const path = join(folder, "image.png");
  const initial = Buffer.concat([png, Buffer.from("original")]);
  const fresh = Buffer.concat([png, Buffer.from("reloaded")]);
  assert.equal(initial.length, fresh.length);
  await fs.writeFile(path, initial);
  const originalStat = fs.stat;
  const original = fs.open;
  const reads = [];
  let opened = 0;
  let closed = 0;
  let changed = false;
  fs.stat = async (...args) => {
    const info = await originalStat(...args);
    if (basename(args[0]) === "image.png") info.ctimeNs = changed ? 1n : 0n;
    return info;
  };
  fs.open = async (...args) => {
    const file = await original(...args);
    if (basename(args[0]) !== "image.png") return file;
    opened++;
    const stat = file.stat.bind(file);
    const read = file.read.bind(file);
    const close = file.close.bind(file);
    file.stat = async (...args) => Object.assign(await stat(...args), { ctimeNs: changed ? 1n : 0n });
    file.read = async (buffer, offset, length, position) => {
      const result = await read(buffer, offset, length, position);
      if (result.bytesRead) reads.push(Buffer.from(buffer.subarray(offset, offset + result.bytesRead)));
      if (!changed) {
        changed = true;
        await fs.mkdir(join(fixture, "unrelated-sibling"));
        await fs.writeFile(path, fresh);
      }
      return result;
    };
    file.close = async () => { closed++; await close(); };
    return file;
  };
  syncBuiltinESMExports();
  t.after(() => { fs.stat = originalStat; fs.open = original; syncBuiltinESMExports(); });
  const image = await saveToolImageFile("thr_sibling", path, () => true);
  assert.ok(opened >= 2 && opened <= 3);
  assert.equal(closed, opened);
  assert.deepEqual(reads[0], initial);
  assert.deepEqual(reads.at(-1), fresh);
  assert.deepEqual(await fs.readFile(join(root, "data", "tool-images", "thr_sibling", `${image.id}.png`)), fresh);
});

for (const platform of process.platform === "linux" ? ["linux", "darwin"] : [process.platform]) {
test(`published images handle unrelated directory changes with ${platform} path validation`, async t => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  t.after(() => Object.defineProperty(process, "platform", originalPlatform));
  const fixture = await mkdtemp(join(tmpdir(), "citropy-image-changing-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(fixture, "workspace");
  await fs.mkdir(folder);
  const path = join(folder, "image.png");
  await fs.writeFile(path, png);
  const original = fs.open;
  let opened = 0;
  let closed = 0;
  fs.open = async (...args) => {
    const file = await original(...args);
    if (basename(args[0]) !== "image.png") return file;
    opened++;
    let changed = false;
    const read = file.read.bind(file);
    const close = file.close.bind(file);
    file.read = async (...args) => {
      if (!changed) {
        changed = true;
        await fs.mkdir(join(fixture, `unrelated-${opened}`));
        await fs.writeFile(join(folder, `unrelated-${opened}`), "");
      }
      return read(...args);
    };
    file.close = async () => { closed++; await close(); };
    return file;
  };
  syncBuiltinESMExports();
  t.after(() => { fs.open = original; syncBuiltinESMExports(); });
  if (platform === "linux") {
    const image = await saveToolImageFile("thr_changing", path, () => true);
    assert.deepEqual(await fs.readFile(join(root, "data", "tool-images", "thr_changing", `${image.id}.png`)), png);
    assert.equal(opened, 1);
    assert.equal(closed, 1);
  } else {
    await assert.rejects(saveToolImageFile("thr_changing", path, () => true), /path changed/);
    assert.equal(opened, 3);
    assert.equal(closed, 3);
    assert.equal(existsSync(join(root, "data", "tool-images", "thr_changing")), false);
  }
});
}

test("closing a conversation during an image read leaves no saved bytes", async t => {
  const fixture = await mkdtemp(join(tmpdir(), "citropy-image-closed-retry-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const folder = join(fixture, "workspace");
  await fs.mkdir(folder);
  const path = join(folder, "image.png");
  await fs.writeFile(path, png);
  const original = fs.open;
  let alive = true;
  let opened = 0;
  let closed = 0;
  fs.open = async (...args) => {
    const file = await original(...args);
    if (basename(args[0]) !== "image.png") return file;
    opened++;
    const read = file.read.bind(file);
    const close = file.close.bind(file);
    file.read = async (...args) => {
      if (alive) {
        await fs.mkdir(join(fixture, "unrelated-sibling"));
        alive = false;
      }
      return read(...args);
    };
    file.close = async () => { closed++; await close(); };
    return file;
  };
  syncBuiltinESMExports();
  t.after(() => { fs.open = original; syncBuiltinESMExports(); });
  await assert.rejects(saveToolImageFile("thr_closed_retry", path, () => alive), /Conversation closed/);
  assert.equal(opened, 1);
  assert.equal(closed, 1);
  assert.equal(existsSync(join(root, "data", "tool-images", "thr_closed_retry")), false);
});

test("published images cannot hang if a checked file is replaced by a FIFO", { skip: process.platform === "win32", timeout: 2000 }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), "citropy-image-fifo-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const path = join(fixture, "image.png");
  await fs.writeFile(path, png);
  const original = fs.open;
  fs.open = async (...args) => {
    if (basename(args[0]) !== "image.png") return original(...args);
    await fs.rm(path);
    execFileSync("mkfifo", [path]);
    return original(...args);
  };
  syncBuiltinESMExports();
  t.after(() => { fs.open = original; syncBuiltinESMExports(); });
  await assert.rejects(saveToolImageFile("thr_fifo", path, () => true), /regular image file/);
});

for (const platform of process.platform === "linux" ? ["linux", "darwin"] : [process.platform]) {
for (const replacement of ["symlink", "directory"]) {
test(`published images reject an intermediate-directory ABA swap using a ${replacement} with ${platform} path validation`, async t => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  t.after(() => Object.defineProperty(process, "platform", originalPlatform));
  const fixture = await mkdtemp(join(tmpdir(), "citropy-image-aba-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const folder = join(fixture, "workspace");
  const savedFolder = join(fixture, "original");
  const outside = join(fixture, "outside");
  await fs.mkdir(folder);
  await fs.mkdir(outside);
  const path = join(folder, "image.png");
  await fs.writeFile(path, png);
  await fs.writeFile(join(outside, "image.png"), Buffer.concat([png, Buffer.from("outside bytes")]));
  async function swap() {
    await fs.rename(folder, savedFolder);
    if (replacement === "symlink") await fs.symlink(outside, folder, "dir");
    else await fs.rename(outside, folder);
  }
  async function restore() {
    if (replacement === "symlink") await fs.rm(folder);
    else await fs.rename(folder, outside);
    await fs.rename(savedFolder, folder);
  }
  const originalStat = fs.stat;
  const originalOpen = fs.open;
  fs.stat = async (...args) => {
    if (basename(args[0]) !== "image.png") return originalStat(...args);
    await swap();
    try { return await originalStat(...args); }
    finally { await restore(); }
  };
  fs.open = async (...args) => {
    if (basename(args[0]) !== "image.png") return originalOpen(...args);
    await swap();
    const file = await originalOpen(...args);
    const close = file.close.bind(file);
    file.close = async () => { try { await close(); } finally { await restore(); } };
    return file;
  };
  syncBuiltinESMExports();
  t.after(() => { fs.stat = originalStat; fs.open = originalOpen; syncBuiltinESMExports(); });
  await assert.rejects(saveToolImageFile("thr_aba", path, () => true), /path changed/);
  assert.equal(existsSync(join(root, "data", "tool-images", "thr_aba")), false);
});
}
}

for (const restored of [true, false]) {
test(`published images ${restored ? "retain the opened file through" : "reject"} a physical file swap with unchanged timestamps`, { skip: process.platform !== "linux" }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), "citropy-image-file-aba-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(fixture, "workspace");
  await fs.mkdir(folder);
  const path = join(folder, "image.png");
  const saved = join(folder, "original.png");
  const outside = join(fixture, "outside.png");
  await fs.writeFile(path, png);
  await fs.writeFile(outside, Buffer.concat([png, Buffer.from("outside bytes")]));
  async function swap() {
    await fs.rename(path, saved);
    await fs.rename(outside, path);
  }
  async function restore() {
    await fs.rename(path, outside);
    await fs.rename(saved, path);
  }
  const originalStat = fs.stat;
  const originalRealpath = fs.realpath;
  const originalOpen = fs.open;
  const handles = [];
  const reads = [];
  let opened = 0;
  fs.stat = async (...args) => {
    assert.notEqual(basename(args[0]), "image.png", "Validate the opened file, not a separate path lookup");
    return originalStat(...args);
  };
  fs.realpath = async (...args) => {
    assert.notEqual(basename(args[0]), "image.png", "Validate the descriptor path, not a separate path lookup");
    return originalRealpath(...args);
  };
  fs.open = async (...args) => {
    const file = await originalOpen(...args);
    handles.push(file);
    if (basename(args[0]) !== "image.png") return file;
    opened++;
    await swap();
    if (restored) await restore();
    const stat = file.stat.bind(file);
    const read = file.read.bind(file);
    const close = file.close.bind(file);
    file.stat = async (...args) => Object.assign(await stat(...args), { ctimeNs: 0n, mtimeNs: 0n });
    file.read = async (buffer, offset, length, position) => {
      const result = await read(buffer, offset, length, position);
      if (result.bytesRead) {
        reads.push(Buffer.from(buffer.subarray(offset, offset + result.bytesRead)));
        if (restored) {
          await swap();
          await restore();
        }
      }
      return result;
    };
    file.close = async () => { try { await close(); } finally { if (!restored) await restore(); } };
    return file;
  };
  syncBuiltinESMExports();
  t.after(() => { fs.stat = originalStat; fs.realpath = originalRealpath; fs.open = originalOpen; syncBuiltinESMExports(); });
  if (restored) {
    const image = await saveToolImageFile("thr_file_aba", path, () => true);
    assert.deepEqual(Buffer.concat(reads), png);
    assert.deepEqual(await fs.readFile(join(root, "data", "tool-images", "thr_file_aba", `${image.id}.png`)), png);
  } else {
    await assert.rejects(saveToolImageFile("thr_file_aba", path, () => true), /path changed/);
    assert.equal(reads.length, 0);
    assert.equal(existsSync(join(root, "data", "tool-images", "thr_file_aba")), false);
  }
  assert.equal(opened, 1);
  assert.equal(handles.length, 2);
  assert.ok(handles.every(file => file.fd === -1));
});
}

test("published images reject a substituted parent before looking up the image", { skip: process.platform !== "linux" }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), "citropy-image-parent-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const folder = join(fixture, "workspace");
  const outside = join(fixture, "outside");
  await fs.mkdir(folder);
  await fs.mkdir(outside);
  const path = join(folder, "image.png");
  await fs.writeFile(path, png);
  await fs.writeFile(join(outside, "image.png"), Buffer.concat([png, Buffer.from("outside bytes")]));
  const originalStat = fs.stat;
  const originalOpen = fs.open;
  const handles = [];
  let lookedUp = false;
  fs.stat = async (...args) => {
    lookedUp = true;
    return originalStat(...args);
  };
  fs.open = async (...args) => {
    assert.equal(args[0], folder);
    const directory = await originalOpen(outside, args[1]);
    handles.push(directory);
    return directory;
  };
  syncBuiltinESMExports();
  t.after(() => { fs.stat = originalStat; fs.open = originalOpen; syncBuiltinESMExports(); });
  await assert.rejects(saveToolImageFile("thr_parent", path, () => true), /path changed/);
  assert.equal(lookedUp, false);
  assert.equal(handles.length, 1);
  assert.equal(handles[0].fd, -1);
  assert.equal(existsSync(join(root, "data", "tool-images", "thr_parent")), false);
});

for (const stage of ["open", "stat", "read"]) {
test(`published images close their descriptors after a file ${stage} failure`, { skip: process.platform !== "linux" }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), "citropy-image-close-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const path = join(fixture, "image.png");
  await fs.writeFile(path, png);
  const failure = new Error(`Failed image ${stage}`);
  const originalOpen = fs.open;
  const handles = [];
  fs.open = async (...args) => {
    const image = basename(args[0]) === "image.png";
    if (image && stage === "open") throw failure;
    const file = await originalOpen(...args);
    handles.push(file);
    if (image && stage === "stat") file.stat = async () => { throw failure; };
    if (image && stage === "read") file.read = async () => { throw failure; };
    return file;
  };
  syncBuiltinESMExports();
  t.after(() => { fs.open = originalOpen; syncBuiltinESMExports(); });
  await assert.rejects(saveToolImageFile("thr_close", path, () => true), error => error === failure);
  assert.equal(handles.length, stage === "open" ? 1 : 2);
  assert.ok(handles.every(file => file.fd === -1));
  assert.equal(existsSync(join(root, "data", "tool-images", "thr_close")), false);
});
}

for (const action of ["rename", "delete"]) {
test(`published images reject ${action} of the opened file`, { skip: process.platform !== "linux" }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), "citropy-image-moved-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const path = join(fixture, "image.png");
  await fs.writeFile(path, png);
  const original = fs.open;
  let changed = false;
  let closed = 0;
  fs.open = async (...args) => {
    const file = await original(...args);
    if (basename(args[0]) !== "image.png") return file;
    const read = file.read.bind(file);
    const close = file.close.bind(file);
    file.read = async (...args) => {
      const result = await read(...args);
      if (!changed) {
        changed = true;
        if (action === "rename") await fs.rename(path, join(fixture, "moved.png"));
        else await fs.unlink(path);
      }
      return result;
    };
    file.close = async () => { closed++; await close(); };
    return file;
  };
  syncBuiltinESMExports();
  t.after(() => { fs.open = original; syncBuiltinESMExports(); });
  await assert.rejects(saveToolImageFile("thr_moved", path, () => true), /path changed/);
  assert.equal(closed, 1);
  assert.equal(existsSync(join(root, "data", "tool-images", "thr_moved")), false);
});
}

for (const target of ["directory", "file"]) {
test(`published images fail closed when the ${target} descriptor path cannot be inspected`, { skip: process.platform !== "linux" }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), "citropy-image-descriptor-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const path = join(fixture, "image.png");
  await fs.writeFile(path, png);
  const originalOpen = fs.open;
  const originalReadlink = fs.readlink;
  const handles = [];
  let fileDescriptor;
  let reads = 0;
  let closed = 0;
  fs.open = async (...args) => {
    const file = await originalOpen(...args);
    handles.push(file);
    if (basename(args[0]) === "image.png") fileDescriptor = `/proc/self/fd/${file.fd}`;
    const read = file.read.bind(file);
    const close = file.close.bind(file);
    file.read = (...args) => { reads++; return read(...args); };
    file.close = async () => { closed++; await close(); };
    return file;
  };
  fs.readlink = async path => {
    assert.match(path, /^\/proc\/self\/fd\/\d+$/);
    if (target === "file" && path !== fileDescriptor) return originalReadlink(path);
    throw Object.assign(new Error("Descriptor path unavailable"), { code: "ENOENT" });
  };
  syncBuiltinESMExports();
  t.after(() => { fs.open = originalOpen; fs.readlink = originalReadlink; syncBuiltinESMExports(); });
  await assert.rejects(saveToolImageFile("thr_no_descriptor", path, () => true), /Descriptor path unavailable/);
  assert.equal(reads, 0);
  assert.equal(closed, target === "directory" ? 1 : 2);
  assert.ok(handles.every(file => file.fd === -1));
  assert.equal(existsSync(join(root, "data", "tool-images", "thr_no_descriptor")), false);
});
}

test("published image retries stay bounded when file contents keep changing", async t => {
  const fixture = await mkdtemp(join(tmpdir(), "citropy-image-writing-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const path = join(fixture, "image.png");
  await fs.writeFile(path, png);
  const original = fs.open;
  const handles = [];
  let opened = 0;
  let closed = 0;
  fs.open = async (...args) => {
    const file = await original(...args);
    handles.push(file);
    if (basename(args[0]) !== "image.png") return file;
    opened++;
    let changed = false;
    const read = file.read.bind(file);
    const close = file.close.bind(file);
    file.read = async (...args) => {
      const result = await read(...args);
      if (!changed) {
        changed = true;
        await fs.appendFile(path, "changed");
      }
      return result;
    };
    file.close = async () => { closed++; await close(); };
    return file;
  };
  syncBuiltinESMExports();
  t.after(() => { fs.open = original; syncBuiltinESMExports(); });
  await assert.rejects(saveToolImageFile("thr_writing", path, () => true), /path changed/);
  assert.equal(opened, 3);
  assert.equal(closed, 3);
  assert.equal(handles.length, process.platform === "linux" ? 6 : 3);
  assert.ok(handles.every(file => file.fd === -1));
  assert.equal(existsSync(join(root, "data", "tool-images", "thr_writing")), false);
});
