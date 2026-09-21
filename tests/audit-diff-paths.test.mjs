import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUnifiedDiff } from '../server/diff.ts';

/** Construct a one-line edit with literal Git/unified filename header fields. */
function edit(oldPath, newPath) {
  return `--- ${oldPath}\n+++ ${newPath}\n@@ -1 +1 @@\n-before\n+after\n`;
}

test('Git octal path escapes decode as UTF-8 bytes, including emoji', () => {
  for (const [encoded, expected] of [
    [String.raw`caf\303\251.txt`, 'café.txt'],
    [String.raw`\360\237\215\213.txt`, '🍋.txt'],
    [String.raw`café\t\303\261.txt`, 'café\tñ.txt'],
  ]) {
    const [patch] = parseUnifiedDiff(edit(`"a/${encoded}"`, `"b/${encoded}"`));
    assert.equal(patch.path, expected);
    assert.equal(patch.added, 1);
    assert.equal(patch.removed, 1);
  }
});

test('Git C-quoted paths preserve quotes, backslashes, tabs, and control characters', () => {
  const encoded = String.raw`quote\"-slash\\-tab\t-newline\n-cr\r-bell\a-back\b-form\f-vertical\v.txt`;
  const [patch] = parseUnifiedDiff(edit(`"a/${encoded}"`, `"b/${encoded}"`));
  assert.equal(patch.path, 'quote"-slash\\-tab\t-newline\n-cr\r-bell\x07-back\b-form\f-vertical\v.txt');
});

test('unquoted filenames retain meaningful leading and trailing spaces', () => {
  for (const name of [' leading.txt', 'trailing.txt ', ' both ', 'folder b/name.txt']) {
    const [patch] = parseUnifiedDiff(`diff --git a/${name} b/${name}\n` + edit(`a/${name}\t`, `b/${name}\t`));
    assert.equal(patch.path, name);
  }
});

test('unified header timestamps are not part of the filename', () => {
  const [patch] = parseUnifiedDiff(edit('a/old name.txt\t2026-09-21 08:00:00 +0000', 'b/new name.txt\t2026-09-21 08:01:00 +0000'));
  assert.equal(patch.path, 'new name.txt');
});

test('plain unified deletions retain the old filename instead of an empty fallback', () => {
  const patches = parseUnifiedDiff('--- a/deleted.txt\t2026-09-21\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n' +
    '--- "a/caf\\303\\251.txt"\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n');
  assert.deepEqual(patches.map(patch => patch.path), ['deleted.txt', 'café.txt']);
  assert.deepEqual(patches.map(patch => patch.removed), [1, 1]);
});

test('metadata-only renames and copies use the exact destination without stripping real directory names', () => {
  const patches = parseUnifiedDiff('diff --git a/old.txt b/b/new name.txt \n' +
    'similarity index 100%\nrename from old.txt\nrename to b/new name.txt \n' +
    'diff --git a/old.txt "b/caf\\303\\251.txt"\nsimilarity index 100%\ncopy from old.txt\ncopy to "caf\\303\\251.txt"\n');
  assert.deepEqual(patches.map(patch => patch.path), ['b/new name.txt ', 'café.txt']);
  assert.deepEqual(patches.map(patch => patch.hunks), [[], []]);
});

test('binary and mode-only changes parse quoted headers and ambiguous b/ substrings', () => {
  const patches = parseUnifiedDiff('diff --git "a/caf\\303\\251.bin" "b/caf\\303\\251.bin"\nBinary files differ\n' +
    'diff --git a/folder b/name.bin b/folder b/name.bin\nold mode 100644\nnew mode 100755\n' +
    'diff --git a/trailing.bin  b/trailing.bin \nBinary files differ\n');
  assert.deepEqual(patches.map(patch => patch.path), ['café.bin', 'folder b/name.bin', 'trailing.bin ']);
});
