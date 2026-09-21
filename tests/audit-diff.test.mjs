import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUnifiedDiff } from '../server/diff.ts';

/** Build the Git file-header prefix used by the hunk parsing regressions. */
const header = path => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`;

test('header-like added and removed source lines stay in their hunk', () => {
  const [patch] = parseUnifiedDiff(header('counter.txt') + '@@ -1,2 +1,2 @@\n--- counter\n+++ counter\n unchanged\n');
  assert.equal(patch.path, 'counter.txt');
  assert.equal(patch.added, 1);
  assert.equal(patch.removed, 1);
  assert.deepEqual(patch.hunks[0].lines, [
    { type: 'del', text: '-- counter', oldNo: 1 },
    { type: 'add', text: '++ counter', newNo: 1 },
    { type: 'ctx', text: 'unchanged', oldNo: 2, newNo: 2 },
  ]);
});

test('multiple files and hunks preserve paths, numbering, and change counts', () => {
  const patches = parseUnifiedDiff(header('first.txt') + '@@ -1 +1 @@\n--- old\n+++ new\n' +
    '@@ -10 +10 @@ section\n-old\n+new\n' + header('second.txt') + '@@ -0,0 +1 @@\n+++ second\n');
  assert.deepEqual(patches.map(({ path, added, removed }) => ({ path, added, removed })), [
    { path: 'first.txt', added: 2, removed: 2 }, { path: 'second.txt', added: 1, removed: 0 },
  ]);
  assert.equal(patches[0].hunks[1].header, 'section');
  assert.equal(patches[0].hunks[1].lines[1].newNo, 10);
});

test('file deletion keeps its path and header-like deleted content', () => {
  const [patch] = parseUnifiedDiff('diff --git a/deleted.txt b/deleted.txt\n--- a/deleted.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n--- deleted\n');
  assert.equal(patch.path, 'deleted.txt');
  assert.equal(patch.removed, 1);
  assert.equal(patch.hunks[0].lines[0].text, '-- deleted');
});

test('plain unified diffs can contain several files without Git headers', () => {
  const patches = parseUnifiedDiff('--- a/first.txt\n+++ b/first.txt\n@@ -1 +1 @@\n-old\n+new\n' +
    '--- a/second.txt\n+++ b/second.txt\n@@ -1 +1 @@\n-before\n+after\n');
  assert.deepEqual(patches.map(patch => patch.path), ['first.txt', 'second.txt']);
  assert.deepEqual(patches.map(patch => patch.hunks.length), [1, 1]);
});

test('no-newline markers do not change hunk line numbers or consume counts', () => {
  const [patch] = parseUnifiedDiff(header('no-newline.txt') + '@@ -1 +1 @@\n--- old\n\\ No newline at end of file\n+++ new\n\\ No newline at end of file\n');
  assert.equal(patch.added, 1);
  assert.equal(patch.removed, 1);
  assert.equal(patch.hunks[0].lines[1].newNo, 1);
});

test('large patches retain total counts while bounding rendered hunk lines', () => {
  const [patch] = parseUnifiedDiff(header('large.txt') + '@@ -0,0 +1,4100 @@\n' + '+++ value\n'.repeat(4100));
  assert.equal(patch.path, 'large.txt');
  assert.equal(patch.added, 4100);
  assert.equal(patch.hunks[0].lines.length, 4000);
  assert.equal(patch.truncated, true);
});
