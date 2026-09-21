import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tree } from '../server/files.ts';

test('file tree rejects an ABA directory replacement during enumeration', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'citropy-race-tree-aba-'));
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
      try {
        return await originalReaddir(path, ...args);
      } finally {
        await fs.unlink(safe);
        await fs.rename(parked, safe);
      }
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
