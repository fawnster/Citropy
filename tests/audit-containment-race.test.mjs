import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request } from 'node:http';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveStatic } from '../server/static.ts';
import { read, tree } from '../server/files.ts';

test('static serving binds containment validation to the opened descriptor', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'citropy-race-static-'));
  const root = join(directory, 'dist');
  await fs.mkdir(root);
  const safe = join(root, 'race.txt');
  const outside = join(directory, 'private.txt');
  await fs.writeFile(safe, 'public');
  await fs.writeFile(outside, 'not public');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const canonicalSafe = fsSync.realpathSync(safe);
  const canonicalOutside = fsSync.realpathSync(outside);
  const originalOpenSync = fsSync.openSync;
  fsSync.openSync = (path, ...args) => originalOpenSync(path === canonicalSafe ? canonicalOutside : path, ...args);
  syncBuiltinESMExports();

  const server = createServer((req, res) => {
    if (!serveStatic(root, req.url, res)) res.writeHead(404).end('not found');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    fsSync.openSync = originalOpenSync;
    syncBuiltinESMExports();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  const result = await new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path: '/race.txt', agent: false }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
      res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    req.end();
  });

  assert.equal(result.status, 404);
  assert.doesNotMatch(result.body, /not public/);
});

test('file previews bind containment validation to the opened descriptor', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'citropy-race-files-'));
  const root = join(directory, 'root');
  await fs.mkdir(root);
  const safe = join(root, 'race.txt');
  const outside = join(directory, 'private.txt');
  await fs.writeFile(safe, 'public');
  await fs.writeFile(outside, 'not public');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const canonicalSafe = await fs.realpath(safe);
  const canonicalOutside = await fs.realpath(outside);
  const originalOpen = fs.open;
  fs.open = async (path, ...args) => originalOpen(path === canonicalSafe ? canonicalOutside : path, ...args);
  syncBuiltinESMExports();
  try {
    assert.equal(await read(root, 'race.txt'), null);
  } finally {
    fs.open = originalOpen;
    syncBuiltinESMExports();
  }
});

test('file tree rejects a directory replaced after containment validation', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'citropy-race-tree-'));
  const root = join(directory, 'root');
  const safe = join(root, 'safe');
  const parked = join(root, 'safe-original');
  const outside = join(directory, 'outside');
  await fs.mkdir(safe, { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(join(safe, 'public.txt'), 'public');
  await fs.writeFile(join(outside, 'secret-name.txt'), 'private');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const canonicalSafe = await fs.realpath(safe);
  const originalReaddir = fs.readdir;
  let swapped = false;
  fs.readdir = async (path, ...args) => {
    if (!swapped && path === canonicalSafe) {
      swapped = true;
      await fs.rename(safe, parked);
      await fs.symlink(outside, safe, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return originalReaddir(path, ...args);
  };
  syncBuiltinESMExports();
  try {
    const entries = await tree(root, 'safe');
    assert.equal(swapped, true);
    assert.deepEqual(entries, []);
    assert.equal(entries.some(entry => entry.name === 'secret-name.txt'), false);
  } finally {
    fs.readdir = originalReaddir;
    syncBuiltinESMExports();
  }
});
