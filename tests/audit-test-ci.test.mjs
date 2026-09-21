import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { failedTestFiles } from '../scripts/test-ci.mjs';

const exec = promisify(execFile);
/** Run the real CI script in a disposable suite; null source represents an empty suite. */
async function suite(t, source) {
  const root = await mkdtemp(join(tmpdir(), 'citropy-ci-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'tests'));
  await copyFile(new URL('../scripts/test-ci.mjs', import.meta.url), join(root, 'scripts', 'test-ci.mjs'));
  if (source !== null) await writeFile(join(root, 'tests', 'example.test.mjs'), source);
  // NODE_TEST_CONTEXT would make nested Node runners behave as test children.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    const result = await exec(process.execPath, ['scripts/test-ci.mjs'], { cwd: root, env, timeout: 15000 });
    return { code: 0, ...result };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test('the CI runner returns success for a clean first pass', async t => {
  const result = await suite(t, "import test from 'node:test'; test('passing', () => {});\n");
  assert.equal(result.code, 0, result.stdout + result.stderr);
});

test('a successful retry never hides the initial CI failure', async t => {
  const result = await suite(t, `
    import test from 'node:test';
    import { existsSync, writeFileSync } from 'node:fs';
    test('fails only once', () => {
      if (!existsSync('attempted')) { writeFileSync('attempted', 'yes'); throw new Error('first run fails'); }
    });
  `);
  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stdout, /Retries passed/);
  assert.match(result.stdout, /CI remains failed/);
});

test('persistent failures remain failures after diagnostic retry', async t => {
  const result = await suite(t, "import test from 'node:test'; test('failing', () => { throw new Error('broken'); });\n");
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /Retry failed/);
});

test('failure paths support file URLs with spaces and cannot escape tests/', () => {
  const root = resolve('path with spaces');
  const file = join(root, 'tests', 'one.test.mjs');
  const url = pathToFileURL(file).href;
  const outside = join(root, '..', 'other', 'tests', 'outside.test.mjs');
  const output = `location: '${url}:12:3'\ntest at ${file}:12:3\nlocation: '${outside}:1:1'\n`;
  assert.deepEqual(failedTestFiles(output, root), ['tests/one.test.mjs']);
});

test('malformed file URLs are ignored instead of aborting retry discovery', () => {
  assert.deepEqual(failedTestFiles("location: 'file:///bad%ZZ/tests/no.test.mjs:1:1'\n"), []);
});


test('an empty suite is not a successful CI run', async t => {
  const result = await suite(t, null);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /No test files found/);
});
