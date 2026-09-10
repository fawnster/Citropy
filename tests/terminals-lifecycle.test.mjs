import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

test("a terminal that fails to spawn can be opened again without a stale session", async () => {
  const pty = createRequire(import.meta.url)("node-pty");
  const originalSpawn = pty.spawn;
  let failure = true;
  const writes = [];
  pty.spawn = () => {
    if (failure) throw new Error("spawn failed");
    return { onData() {}, onExit() {}, kill() {}, write: (text) => writes.push(text) };
  };
  try {
    const terminals = await import("../server/terminals.ts");
    assert.throws(() => terminals.open("retry", "/workspace", 80, 24), /spawn failed/);
    failure = false;
    terminals.open("retry", "/workspace", 80, 24);
    terminals.write("retry", "recovered");
    assert.deepEqual(writes, ["recovered"]);
    terminals.closeAll();
    assert.equal(terminals.read("retry"), "");
  } finally {
    pty.spawn = originalSpawn;
  }
});
