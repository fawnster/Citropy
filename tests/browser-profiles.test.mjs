import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

test("browser profiles isolate imported cookies and preserve source databases", async (t) => {
  const directory = fs.mkdtempSync(join(os.tmpdir(), "citropy-profiles-"));
  const originalHome = os.homedir;
  os.homedir = () => directory;
  syncBuiltinESMExports();
  t.after(() => {
    os.homedir = originalHome;
    syncBuiltinESMExports();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const { initializeProfiles, handleProfiles, browserProfile, decryptCookie } =
    await import("../desktop/browser-profiles.mjs");
  await initializeProfiles(directory);
  const partitions = new Map();
  const session = {
    fromPartition: (id) => {
      if (!partitions.has(id)) {
        const saved = [];
        partitions.set(id, {
          cookies: {
            get: async () => saved,
            set: async (cookie) => saved.push(cookie),
            flushStore: async () => {},
          },
          clearStorageData: async () => {
            saved.length = 0;
          },
          clearCache: async () => {},
        });
      }
      return partitions.get(id);
    },
  };
  const tabs = new Map();
  const action = (operation, input = {}) =>
    handleProfiles(
      operation,
      { projectId: "fixture", method: "POST", ...input },
      session,
      tabs,
    );
  const initial = await action("profiles", { method: "GET" });
  assert.equal(initial.selected, "workspace");
  assert.equal(browserProfile("fixture").partition, "persist:citropy-fixture");
  const parallel = await Promise.all([
    action("profiles", { name: "Personal" }),
    action("profiles", { name: "Testing" }),
  ]);
  const profileId = parallel[1].selected;
  assert.equal(
    JSON.parse(
      fs.readFileSync(join(directory, "browser-profiles.json"), "utf8"),
    ).fixture.profiles.length,
    3,
  );
  assert.notEqual(
    browserProfile("fixture", profileId).partition,
    browserProfile("fixture", "workspace").partition,
  );
  const root = join(directory, ".mozilla/firefox/fixture.default");
  fs.mkdirSync(root, { recursive: true });
  const path = join(root, "cookies.sqlite");
  const database = new DatabaseSync(path);
  database.exec(
    "CREATE TABLE moz_cookies (host TEXT, name TEXT, value TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER, originAttributes TEXT)",
  );
  const insert = database.prepare(
    "INSERT INTO moz_cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run(
    ".example.test",
    "session",
    "fixture-cookie",
    "/",
    4000000000,
    1,
    1,
    1,
    "",
  );
  insert.run("example.test", "expired", "old", "/", 1, 1, 0, 1, "");
  insert.run(
    "example.test",
    "partitioned",
    "private",
    "/",
    4000000000,
    1,
    0,
    1,
    "^partitionKey=example.test",
  );
  database.close();
  const before = fs.readFileSync(path);
  const sources = await action("sources", { method: "GET" });
  assert.equal(sources.length, 1);
  assert.equal(Object.hasOwn(sources[0], "path"), false);
  const imported = await action("import", {
    profileId,
    sourceId: sources[0].id,
  });
  assert.deepEqual(imported, { imported: 1, skipped: 2 });
  assert.deepEqual(fs.readFileSync(path), before);
  const state = await action("profiles", { method: "GET" });
  assert.equal(
    state.profiles.find((entry) => entry.id === "workspace").cookies,
    0,
  );
  assert.equal(
    state.profiles.find((entry) => entry.id === profileId).cookies,
    1,
  );
  const cookie = (
    await session
      .fromPartition(browserProfile("fixture", profileId).partition)
      .cookies.get({})
  )[0];
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.secure, true);
  assert.equal(cookie.sameSite, "lax");
  tabs.set("open", { state: { projectId: "fixture", profileId } });
  await assert.rejects(
    action("profiles", { method: "DELETE", id: profileId }),
    /Close/,
  );
  tabs.clear();
  await action("clear", { profileId, kind: "cookies" });
  await action("profiles", { method: "DELETE", id: profileId });
  assert.equal(browserProfile("fixture").id, "workspace");
  const key = pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
  const host = ".example.test";
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
  const encrypted = Buffer.concat([
    Buffer.from("v10"),
    cipher.update(
      Buffer.concat([
        createHash("sha256").update(host).digest(),
        Buffer.from("encrypted-fixture"),
      ]),
    ),
    cipher.final(),
  ]);
  assert.equal(
    decryptCookie(encrypted, host, 24, { v10: key }),
    "encrypted-fixture",
  );
  assert.equal(decryptCookie(encrypted, ".wrong.test", 24, { v10: key }), null);
  assert.equal(
    decryptCookie(Buffer.from("v20unsupported"), host, 24, { v10: key }),
    null,
  );
});
