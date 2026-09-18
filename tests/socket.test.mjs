import assert from "node:assert/strict";
import { test } from "node:test";

test("the local connection recovers without replaying GitHub actions", { timeout: 10000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const frames = new Map();
  let nextFrame = 0;
  const sockets = [];
  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    sent = [];
    constructor(url) {
      this.url = new URL(url);
      sockets.push(this);
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    send(raw) {
      this.sent.push(JSON.parse(raw));
    }
    message(event) {
      this.onmessage?.({ data: JSON.stringify(event) });
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  globalThis.WebSocket = FakeWebSocket;
  globalThis.location = { protocol: "http:", host: "127.0.0.1:4177" };
  globalThis.localStorage = { getItem: () => null };
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  const { connect, disconnect } = await import("../web/src/lib/socket.ts");
  const { useApp } = await import("../web/src/lib/store.ts");
  const { github, fetchFile, fetchTree, fetchDiff, manageGit } = await import("../web/src/lib/actions.ts");
  const hello = {
    t: "hello",
    snapshot: {
      projects: [],
      threads: [],
      providers: [],
      permissions: [],
      home: "/test",
    },
  };
  const flush = () => {
    for (const callback of [...frames.values()]) callback();
  };

  await t.test("starting the connection twice uses one socket", () => {
    connect();
    connect();
    assert.equal(sockets.length, 1);
  });
  let current = sockets.at(-1);
  current.open();
  current.message(hello);
  flush();

  await t.test(
    "interrupted requests finish promptly and are never replayed",
    async () => {
      let error;
      const pending = github("comment", {
        repo: "owner/repo",
        number: 1,
        body: "A comment",
      }).catch((reason) => {
        error = reason;
      });
      current.close();
      await pending;
      assert.match(error?.message ?? "", /interrupted/i);
      assert.equal(useApp.getState().connected, false);
      t.mock.timers.tick(400);
      current = sockets.at(-1);
      current.open();
      current.message(hello);
      flush();
      assert.equal(useApp.getState().connected, true);
      assert.deepEqual(current.sent, []);
    },
  );

  await t.test(
    "late callbacks from an old socket cannot disconnect the new one",
    () => {
      sockets[0].onclose();
      assert.equal(useApp.getState().connected, true);
    },
  );

  await t.test(
    "a reply received immediately before disconnection is preserved",
    async () => {
      const pending = github("repositories", { page: 1 });
      const request = current.sent.at(-1);
      current.message({
        t: "github.result",
        requestId: request.requestId,
        result: { items: [], more: false },
      });
      current.close();
      assert.deepEqual(await pending, { items: [], more: false });
    },
  );

  await t.test(
    "GitHub actions cannot enter the offline message queue",
    async () => {
      t.mock.timers.tick(400);
      current = sockets.at(-1);
      current.open();
      current.message(hello);
      flush();
      current.readyState = 2;
      const pending = github("comment", {
        repo: "owner/repo",
        number: 1,
        body: "Do not replay",
      });
      flush();
      await assert.rejects(pending, /not sent/);
      current.close();
      t.mock.timers.tick(400);
      current = sockets.at(-1);
      current.open();
      assert.deepEqual(current.sent, []);
    },
  );

  await t.test("reconnect resumes its cursor, ignores duplicates and requests a snapshot after a gap", () => {
    current.message({ ...hello, epoch: "server-a", sequence: 10 });
    const project = { id: "project", path: "/project", name: "Before reconnect", lastOpened: 1 };
    current.message({ t: "project.upsert", project, sequence: 11 });
    current.close();
    t.mock.timers.tick(400);
    current = sockets.at(-1);
    assert.equal(current.url.searchParams.get("epoch"), "server-a");
    assert.equal(current.url.searchParams.get("after"), "11");
    current.open();
    current.message({ t: "project.upsert", project: { ...project, name: "Duplicate" }, sequence: 11 });
    current.message({ t: "project.upsert", project: { ...project, name: "Recovered" }, sequence: 12 });
    current.message({ t: "reconnected", epoch: "server-a", sequence: 12, shells: [], browsers: [] });
    assert.equal(useApp.getState().connected, true);
    assert.equal(useApp.getState().projects[0].name, "Recovered");
    current.message({ t: "project.upsert", project: { ...project, name: "Gap" }, sequence: 14 });
    assert.equal(current.readyState, 3);
    t.mock.timers.tick(400);
    current = sockets.at(-1);
    assert.equal(current.url.searchParams.has("epoch"), false);
    current.open();
    current.message({ ...hello, epoch: "server-b", sequence: 1 });
    flush();
    assert.deepEqual(useApp.getState().projects, []);
  });

  await t.test("disconnect releases every request type and explicit cleanup never reconnects", async () => {
    current.message(hello);
    flush();
    const pending = Promise.allSettled([
      fetchFile("project", "file.ts"),
      fetchTree("project"),
      fetchDiff("project", "file.ts", false),
      manageGit("project", "overview"),
    ]);
    disconnect();
    for (const result of await pending) {
      assert.equal(result.status, "rejected");
      assert.match(result.reason.message, /interrupted/);
    }
    const count = sockets.length;
    t.mock.timers.tick(65_000);
    assert.equal(sockets.length, count);
    assert.equal(frames.size, 0);
    for (let index = 0; index < 10; index++) {
      connect();
      sockets.at(-1).open();
      disconnect();
    }
    t.mock.timers.tick(65_000);
    assert.equal(sockets.length, count + 10);
  });

  t.mock.timers.reset();
  for (const key of [
    "WebSocket",
    "location",
    "localStorage",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ])
    delete globalThis[key];
});
