import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";

test("live configuration helpers", async (t) => {
  const directory = fs.mkdtempSync(join(os.tmpdir(), "citropy-live-configure-"));
  const originalHomedir = os.homedir;
  os.homedir = () => directory;
  syncBuiltinESMExports();
  t.after(() => {
    os.homedir = originalHomedir;
    syncBuiltinESMExports();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const { ThreadRuntime, runtimeIfExists } = await import("../server/runtime.ts");
  const { receiveAgentEvent } = await import("../server/providers/events.ts");

  await t.test("runtimeIfExists only returns registered runtimes", () => {
    assert.equal(runtimeIfExists("missing-thread"), undefined);
    const runtime = new ThreadRuntime({ id: "local-thread", running: false });
    assert.equal(runtime.id, "local-thread");
    assert.equal(runtimeIfExists("local-thread"), undefined);
  });

  await t.test("a runtime without a live session cannot configure", async () => {
    const runtime = new ThreadRuntime({ id: "local-thread", running: false });
    assert.equal(await runtime.configure({ model: "next" }), false);
  });

  await t.test("the provider title event validates and passes through", () => {
    assert.deepEqual(receiveAgentEvent("cursor", "t", { type: "title", title: "Hello" }), { type: "title", title: "Hello" });
  });
});
