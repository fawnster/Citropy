import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUnifiedDiff } from '../server/diff.ts';

/** Parse one complete replacement so path handling is exercised alongside real hunk accounting. */
function replacement(oldPath, newPath) {
  return parseUnifiedDiff(`--- ${oldPath}\n+++ ${newPath}\n@@ -1 +1 @@\n-old\n+new\n`)[0];
}

test('Git octal byte escapes decode as UTF-8, not individual Unicode characters', () => {
  const path = '"b/caf\\303\\251-\\347\\214\\253.txt"';
  assert.equal(replacement('"a/old.txt"', path).path, 'café-猫.txt');
});

test('quoted path escapes preserve tabs, line breaks, quotes, and backslashes', () => {
  assert.equal(replacement('a/old.txt', String.raw`"b/tab\tline\nquote\"back\\.txt"`).path, 'tab\tline\nquote"back\\.txt');
});

test('unquoted filenames preserve leading and trailing spaces', () => {
  assert.equal(replacement('a/ leading.txt ', 'b/ leading.txt ').path, ' leading.txt ');
});

test('plain unified deletion retains the old filename without a fallback', () => {
  const [patch] = parseUnifiedDiff('--- removed.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n');
  assert.equal(patch.path, 'removed.txt');
  assert.equal(patch.removed, 1);
});

test('plain unified header timestamps are not part of filenames', () => {
  assert.equal(replacement('old.txt\t2026-01-01 00:00:00 +0000', 'new.txt\t2026-01-02 00:00:00 +0000').path, 'new.txt');
});

test('quoted Git deletion retains a decoded old filename', () => {
  const [patch] = parseUnifiedDiff(String.raw`diff --git "a/caf\303\251.txt" "b/caf\303\251.txt"` + '\n' + String.raw`--- "a/caf\303\251.txt"` + '\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n');
  assert.equal(patch.path, 'café.txt');
});

test('rename-only metadata keeps the entire destination, including a real b/ directory', () => {
  const [patch] = parseUnifiedDiff('diff --git a/old.txt b/b/new name.txt\nsimilarity index 100%\nrename from old.txt\nrename to b/new name.txt\n');
  assert.equal(patch.path, 'b/new name.txt');
});

test('mode-only diffs distinguish embedded b/ directories from the header separator', () => {
  const path = 'dir b/file.txt';
  const [patch] = parseUnifiedDiff(`diff --git a/${path} b/${path}\nold mode 100644\nnew mode 100755\n`);
  assert.equal(patch.path, path);
});

test('quoted copy-only metadata is decoded without stripping a real a/ or b/ directory', () => {
  const [patch] = parseUnifiedDiff('diff --git a/old.txt b/b/new.txt\nsimilarity index 100%\ncopy from old.txt\ncopy to "b/caf\\303\\251.txt"\n');
  assert.equal(patch.path, 'b/café.txt');
});
