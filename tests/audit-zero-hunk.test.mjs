import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUnifiedDiff } from '../server/diff.ts';

test('zero-length diff headers do not create phantom hunks', () => {
  const [patch] = parseUnifiedDiff(
    'diff --git a/empty.txt b/empty.txt\n' +
    '--- a/empty.txt\n' +
    '+++ b/empty.txt\n' +
    '@@ -0,0 +0,0 @@ noop\n',
  );

  assert.equal(patch.path, 'empty.txt');
  assert.equal(patch.added, 0);
  assert.equal(patch.removed, 0);
  assert.deepEqual(patch.hunks, []);
});
