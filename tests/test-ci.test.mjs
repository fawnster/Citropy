import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { failedTestFiles } from "../scripts/test-ci.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("CI retries find failed files in spec and TAP output", () => {
  assert.deepEqual(
    failedTestFiles(
      `
✖ fails (1.2ms)
test at ${root}/tests/window-reveal.test.mjs:12:1
✖ another
test at tests/app-updates.test.mjs:4:2
test at file://${root}/tests/branding-migration.test.mjs:3:1
`,
      root,
    ).sort(),
    [
      "tests/app-updates.test.mjs",
      "tests/branding-migration.test.mjs",
      "tests/window-reveal.test.mjs",
    ],
  );
  assert.deepEqual(
    failedTestFiles(
      `
not ok 1 - fails
  ---
  location: '${root}/tests/environment-snapshot.test.mjs:1:1'
  ...
`,
      root,
    ),
    ["tests/environment-snapshot.test.mjs"],
  );
  assert.deepEqual(failedTestFiles("✔ passes (1ms)\nℹ tests 1\n", root), []);
});
