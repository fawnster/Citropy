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
async function suite(t, source, args = []) {
  const root = await mkdtemp(join(tmpdir(), 'citropy-ci-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'tests'));
  await copyFile(new URL('../scripts/test-ci.mjs', import.meta.url), join(root, 'scripts', 'test-ci.mjs'));
  const files = typeof source === 'string' ? { 'example.test.mjs': source } : source;
  for (const [name, content] of Object.entries(files ?? {})) {
    await writeFile(join(root, 'tests', name), content);
  }
  // NODE_TEST_CONTEXT would make nested Node runners behave as test children.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    const result = await exec(process.execPath, ['scripts/test-ci.mjs', ...args], { cwd: root, env, timeout: 15000 });
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

test('CI shards cover every file exactly once in deterministic order', async t => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const files = Object.fromEntries(names.map(name => [
    `${name}.test.mjs`,
    `import test from 'node:test'; test('selected ${name}', () => {});`,
  ]));
  const selected = [];
  for (const index of [1, 2, 3]) {
    const result = await suite(t, files, ['--test-shard', `${index}/3`]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const shard = [...result.stdout.matchAll(/^# Subtest: selected (\w+)$/gm)].map(match => match[1]);
    assert.deepEqual(shard, names.filter((_, position) => position % 3 === index - 1));
    selected.push(...shard);
  }
  assert.deepEqual(selected.sort(), names);
});

test('CI rejects invalid and empty shard configurations', async t => {
  for (const shard of ['0/1', '1/0', '2/1', '1.5/2', '1', '', '1/2', '2/2']) {
    const result = await suite(t, "import test from 'node:test'; test('passing', () => {});", [`--test-shard=${shard}`]);
    assert.notEqual(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /Invalid test shard/);
    assert.doesNotMatch(result.stdout, /# Subtest:/);
  }
});

test('diagnostic retries execute failed shard files without resharding or hiding failure', async t => {
  const result = await suite(t, {
    'first.test.mjs': "import test from 'node:test'; test('unselected', () => { throw new Error('unselected file ran'); });",
    'second.test.mjs': `
      import test from 'node:test';
      import { existsSync, writeFileSync } from 'node:fs';
      test('fails only once', () => {
        if (!existsSync('attempted')) { writeFileSync('attempted', 'yes'); throw new Error('first run fails'); }
        console.log('diagnostic retry executed');
      });
    `,
  }, ['--test-shard=2/2']);
  assert.notEqual(result.code, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /unselected/);
  assert.match(result.stdout, /Retrying 1 test file\(s\)/);
  assert.match(result.stdout, /diagnostic retry executed/);
  assert.match(result.stdout, /Retries passed/);
  assert.match(result.stdout, /CI remains failed/);
});

test('the CI runner overlaps independent files on its first pass', async t => {
  const source = (name, peer) => `
    import assert from 'node:assert/strict';
    import test from 'node:test';
    import { existsSync, writeFileSync } from 'node:fs';
    import { setTimeout } from 'node:timers/promises';
    test('overlaps ${name}', async () => {
      writeFileSync('${name}.ready', 'yes');
      const deadline = Date.now() + 5000;
      while (!existsSync('${peer}.ready') && Date.now() < deadline) await setTimeout(10);
      assert.ok(existsSync('${peer}.ready'), 'Independent files did not run together');
    });
  `;
  const result = await suite(t, {
    'first.test.mjs': source('first', 'second'),
    'second.test.mjs': source('second', 'first'),
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);
});

test('diagnostic retries run failed files serially', async t => {
  const source = name => `
    import test from 'node:test';
    import { existsSync, writeFileSync, mkdirSync, rmdirSync } from 'node:fs';
    import { setTimeout } from 'node:timers/promises';
    test('retries ${name}', async () => {
      if (!existsSync('${name}.attempted')) {
        writeFileSync('${name}.attempted', 'yes');
        throw new Error('first run fails');
      }
      mkdirSync('retry-active');
      try { await setTimeout(100); } finally { rmdirSync('retry-active'); }
    });
  `;
  const result = await suite(t, {
    'first.test.mjs': source('first'),
    'second.test.mjs': source('second'),
  });
  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stdout, /Retrying 2 test file\(s\)/);
  assert.match(result.stdout, /Retries passed/);
  assert.match(result.stdout, /CI remains failed/);
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
