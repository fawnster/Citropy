import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));

test("the ACP provider replays session updates that arrive while a resume is loading", { timeout: 60_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-acp-resume-"));
  const binary = join(directory, "cursor-agent");
  await writeFile(binary, `#!/bin/sh\nexec node ${JSON.stringify(fixture)} "$@"\n`, { mode: 0o755 });
  await chmod(binary, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${directory}:${originalPath}`;
  process.env.CITROPY_DATA_DIR = join(directory, "data");
  process.env.FAKE_ACP_RESUME_UPDATES = "1";

  const { cursorProvider } = await import("../server/providers/cursor.ts");
  const { store } = await import("../server/store.ts");

  t.after(async () => {
    process.env.PATH = originalPath;
    delete process.env.CITROPY_DATA_DIR;
    delete process.env.FAKE_ACP_RESUME_UPDATES;
    store.flush();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rm(directory, { recursive: true, force: true });
  });

  const waitFor = async (predicate, message, timeout = 20_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${message}`);
  };

  const events = [];
  const session = cursorProvider.start({
    threadId: "acp-resume",
    cwd: directory,
    permissionMode: "manual",
    externalId: "resume-thread",
    emit: (event) => events.push(event),
  });
  t.after(() => session.dispose());

  const handshake = await waitFor(() => events.find((event) => event.type === "session"), "the resumed session");
  assert.equal(handshake.externalId, "resume-thread");
  const tool = events.find((event) => event.type === "tool.start" && event.callId === "resume-tool");
  assert.ok(tool, "the buffered tool call from the resume was replayed");
  assert.equal(tool.name, "Bash");
  const todos = events.findLast((event) => event.type === "todos");
  assert.deepEqual(todos.items.map((item) => item.text), ["Restored step"]);
  const title = events.find((event) => event.type === "title");
  assert.equal(title?.title, "Resumed thread");
});
