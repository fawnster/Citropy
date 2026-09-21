import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { read, inside, tree } from '../server/files.ts';

const LIMIT = 512 * 1024;
const suffix = '\n… truncated at 512 KB';
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'citropy-files-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('small, empty, exact-limit, and oversized text previews have correct boundaries', async t => {
  const root = await fixture(t);
  for (const size of [0, 7, LIMIT, LIMIT + 1, 2 * LIMIT]) {
    await fs.writeFile(join(root, 'preview.txt'), 'a'.repeat(size));
    assert.equal(await read(root, 'preview.txt'), 'a'.repeat(Math.min(size, LIMIT)) + (size > LIMIT ? suffix : ''));
  }
});

test('large previews never call the unbounded readFile API', async t => {
  const root = await fixture(t);
  await fs.writeFile(join(root, 'large.txt'), 'a'.repeat(LIMIT + 10));
  const original = fs.readFile;
  let wholeFileReads = 0;
  fs.readFile = async (...args) => { wholeFileReads++; return original(...args); };
  syncBuiltinESMExports();
  try {
    assert.equal(await read(root, 'large.txt'), 'a'.repeat(LIMIT) + suffix);
    assert.equal(wholeFileReads, 0, 'a preview must not allocate the whole input file');
  } finally { fs.readFile = original; syncBuiltinESMExports(); }
});

test('truncation never invents a replacement character inside valid UTF-8', async t => {
  const root = await fixture(t);
  for (const character of ['é', '€', '🍋']) {
    const prefix = 'a'.repeat(LIMIT - 1);
    await fs.writeFile(join(root, 'unicode.txt'), prefix + character + 'tail');
    assert.equal(await read(root, 'unicode.txt'), prefix + suffix);
  }
  await fs.writeFile(join(root, 'unicode.txt'), 'é🍋');
  assert.equal(await read(root, 'unicode.txt'), 'é🍋');
});

test('missing files, directories, and parent traversal are not readable', async t => {
  const root = await fixture(t);
  assert.equal(await read(root, 'missing'), null);
  assert.equal(await read(root, '.'), null);
  assert.equal(await read(root, '../outside.txt'), null);
  assert.equal(inside(root, '../outside.txt'), null);
});

test('file tree ordering and hidden-file policy are preserved', async t => {
  const root = await fixture(t);
  await fs.mkdir(join(root, 'folder'));
  await fs.mkdir(join(root, 'node_modules'));
  await fs.writeFile(join(root, 'z.txt'), 'z');
  await fs.writeFile(join(root, '.secret'), 's');
  await fs.writeFile(join(root, '.env.example'), 'example');
  assert.deepEqual((await tree(root)).map(entry => entry.name), ['folder', '.env.example', 'z.txt']);
});

test('short reads are retried and the descriptor is closed', async t => {
  const root = await fixture(t);
  await fs.writeFile(join(root, 'short.txt'), 'several short reads 🍋');
  const original = fs.open;
  let reads = 0;
  let closed = false;
  fs.open = async (...args) => {
    const handle = await original(...args);
    const read = handle.read.bind(handle);
    const close = handle.close.bind(handle);
    handle.read = (buffer, offset, length, position) => { reads++; return read(buffer, offset, Math.min(length, 3), position); };
    handle.close = async () => { closed = true; await close(); };
    return handle;
  };
  syncBuiltinESMExports();
  try {
    assert.equal(await read(root, 'short.txt'), 'several short reads 🍋');
    assert.ok(reads > 1);
    assert.equal(closed, true);
  } finally { fs.open = original; syncBuiltinESMExports(); }
});

test('read failures close the descriptor and return null', async t => {
  const root = await fixture(t);
  await fs.writeFile(join(root, 'error.txt'), 'test');
  const original = fs.open;
  let closed = false;
  fs.open = async (...args) => {
    const handle = await original(...args);
    const close = handle.close.bind(handle);
    handle.read = async () => { throw new Error('simulated read failure'); };
    handle.close = async () => { closed = true; await close(); };
    return handle;
  };
  syncBuiltinESMExports();
  try {
    assert.equal(await read(root, 'error.txt'), null);
    assert.equal(closed, true);
  } finally { fs.open = original; syncBuiltinESMExports(); }
});
