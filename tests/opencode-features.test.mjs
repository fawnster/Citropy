import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";

async function until(check) {
  for (let index = 0; index < 200; index++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Expected provider event was not received");
}

test(
  "OpenCode sends attachments and distinguishes failed, manual, and automatic compaction",
  { timeout: 15000 },
  async (t) => {
    const originalSpawn = childProcess.spawn;
    const events = [];
    const requests = [];
    let stream;
    let pending;
    let session;
    const server = http.createServer(async (req, res) => {
      if (req.url === "/event") {
        stream = res;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": ready\n\n");
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push({ path: req.url, body: JSON.parse(body || "{}") });
      res.setHeader("content-type", "application/json");
      if (req.url === "/command") res.end(JSON.stringify([{ name: "test", description: "Run project tests" }]));
      else if (req.url === "/session") res.end(JSON.stringify({ id: "fixture" }));
      else if (
        req.url === "/session/fixture/command" ||
        req.url === "/session/fixture/message" ||
        req.url === "/session/fixture/summarize"
      )
        pending = res;
      else res.end("true");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    childProcess.spawn = () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {
        queueMicrotask(() => child.emit("close", 0));
        return true;
      };
      queueMicrotask(() =>
        child.stdout.write(`http://127.0.0.1:${server.address().port}\n`),
      );
      return child;
    };
    syncBuiltinESMExports();
    t.after(async () => {
      session?.dispose();
      stream?.end();
      pending?.end("false");
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
    });
    const { opencodeProvider } = await import(
      "../server/providers/opencode.ts"
    );
    session = opencodeProvider.start({
      threadId: "fixture",
      cwd: "/tmp",
      model: "service/model",
      permissionMode: "bypass",
      emit: (event) => events.push(event),
    });
    await until(
      () => stream && events.some((event) => event.type === "session"),
    );
    const notify = (type, properties = {}) =>
      stream.write(
        `data: ${JSON.stringify({ type, properties: { sessionID: "fixture", ...properties } })}\n\n`,
      );
    session.send(
      "Read these",
      [
        {
          path: "/tmp/image with spaces.png",
          label: "image with spaces.png",
          mime: "image/png",
        },
      ],
      [{ name: "review", path: "/tmp/SKILL.md" }],
    );
    await until(() => pending);
    assert.equal(
      requests.at(-1).body.parts[1].url,
      "file:///tmp/image%20with%20spaces.png",
    );
    assert.match(requests.at(-1).body.parts[0].text, /SKILL.md/);
    pending.end("{}");
    pending = undefined;
    await until(() => events.some((event) => event.type === "turn.end"));
    const beforeCommand = events.filter(event => event.type === "turn.end").length;
    session.send("/test core", [{ path: "/tmp/notes.txt", label: "notes.txt", mime: "text/plain" }], [{ name: "review", path: "/tmp/SKILL.md" }]);
    await until(() => pending);
    assert.equal(requests.at(-1).path, "/session/fixture/command");
    assert.equal(requests.at(-1).body.command, "test");
    assert.match(requests.at(-1).body.arguments, /^core\n\nUse the review skill/);
    assert.equal(requests.at(-1).body.model, "service/model");
    assert.equal(requests.at(-1).body.parts[0].url, "file:///tmp/notes.txt");
    pending.end("{}");
    pending = undefined;
    await until(() => events.filter(event => event.type === "turn.end").length > beforeCommand);
    let compact = session.compact();
    await until(() => pending);
    assert.deepEqual(requests.at(-1), {
      path: "/session/fixture/summarize",
      body: { providerID: "service", modelID: "model", auto: false },
    });
    pending.end("false");
    pending = undefined;
    await assert.rejects(compact, /did not complete/);
    assert.equal(
      events.some((event) => event.type === "compacted"),
      false,
    );
    compact = session.compact();
    await until(() => pending);
    notify("session.error", {
      error: { data: { message: "Provider limit reached" } },
    });
    notify("message.updated", {
      info: {
        id: "failed-summary",
        role: "assistant",
        tokens: { input: 20, output: 1 },
      },
    });
    await until(() => events.some((event) => event.type === "usage"));
    pending.end("true");
    pending = undefined;
    await assert.rejects(compact, /Provider limit reached/);
    compact = session.compact();
    await until(() => pending);
    notify("message.part.updated", {
      part: { id: "summary", type: "text", text: "Internal summary" },
    });
    notify("session.compacted");
    pending.end("true");
    pending = undefined;
    await compact;
    assert.equal(
      events.filter((event) => event.type === "compacted").length,
      1,
    );
    assert.equal(
      events.some(
        (event) =>
          event.type === "block.delta" && event.text === "Internal summary",
      ),
      false,
    );
    session.send("Continue");
    await until(() => pending);
    notify("session.compacted");
    await until(
      () => events.filter((event) => event.type === "compacted").length === 2,
    );
    assert.equal(events.filter((event) => event.type === "turn.end").length, beforeCommand + 1);
    pending.end("{}");
    pending = undefined;
    await until(
      () => events.filter((event) => event.type === "turn.end").length === beforeCommand + 2,
    );
  },
);
