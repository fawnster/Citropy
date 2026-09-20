import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { migrateDesktopData } from "../desktop/migrate-data.mjs";
import { migratePreferences } from "../web/src/lib/migrate-preferences.ts";

function temporary(t) {
  const path = mkdtempSync(join(tmpdir(), "citropy-migration-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function write(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, value);
}

test("browser preferences migrate once without replacing Citropy choices or unrelated data", () => {
  const values = new Map([["loom.theme", "dark"], ["loom.uiScale", "140"], ["loom.thread", "saved-chat"], ["citropy.theme", "light"], ["unrelated", "preserved"]]);
  const storage = {
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  migratePreferences(storage);
  migratePreferences(storage);
  assert.deepEqual(Object.fromEntries(values), { "citropy.theme": "light", unrelated: "preserved", "citropy.uiScale": "140", "citropy.thread": "saved-chat" });
});

test("desktop migration preserves settings and workspace cookies", (t) => {
  const directory = temporary(t);
  write(join(directory, "Loom", "window.json"), '{"width":1440}');
  write(join(directory, "Loom", "Partitions", "loom-workspace", "Cookies"), "cookie database");
  const root = migrateDesktopData(directory);
  assert.equal(root, join(directory, "Citropy"));
  assert.equal(existsSync(join(directory, "Loom")), false);
  assert.equal(readFileSync(join(root, "window.json"), "utf8"), '{"width":1440}');
  assert.equal(readFileSync(join(root, "Partitions", "citropy-workspace", "Cookies"), "utf8"), "cookie database");
  assert.equal(migrateDesktopData(directory), root);
});

test("existing profiles, partition collisions, and explicit desktop paths are preserved", (t) => {
  const directory = temporary(t);
  write(join(directory, "Loom", "window.json"), "old");
  write(join(directory, "Citropy", "window.json"), "current");
  write(join(directory, "Citropy", "Partitions", "loom-workspace", "Cookies"), "old cookies");
  write(join(directory, "Citropy", "Partitions", "citropy-workspace", "Cookies"), "current cookies");
  migrateDesktopData(directory);
  assert.equal(readFileSync(join(directory, "Loom", "window.json"), "utf8"), "old");
  assert.equal(readFileSync(join(directory, "Citropy", "window.json"), "utf8"), "current");
  assert.equal(readFileSync(join(directory, "Citropy", "Partitions", "loom-workspace", "Cookies"), "utf8"), "old cookies");
  assert.equal(readFileSync(join(directory, "Citropy", "Partitions", "citropy-workspace", "Cookies"), "utf8"), "current cookies");
  const override = join(directory, "isolated");
  assert.equal(migrateDesktopData(directory, override), override);
  assert.equal(existsSync(override), false);
});

test("conversation directory migration retains saved bytes and never overwrites an existing destination", (t) => {
  for (const existing of [false, true]) {
    const directory = temporary(t);
    const saved = JSON.stringify({ id: "saved", projectId: "workspace", status: "idle", running: false, messages: [{ id: "response", role: "assistant", parts: [{ id: "text", kind: "text", text: "Preserved response", complete: false }] }] });
    write(join(directory, ".loom", "threads", "saved.json"), saved);
    if (existing) write(join(directory, ".citropy", "threads", "current.json"), saved.replace('"saved"', '"current"'));
    const result = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `const { store } = await import(${JSON.stringify(new URL("../server/store.ts", import.meta.url).href)}); process.stdout.write(JSON.stringify([...store.threads.values()]));`], { env: { ...process.env, HOME: directory }, encoding: "utf8" });
    const threads = JSON.parse(result);
    assert.equal(threads.length, 1);
    assert.equal(threads[0].id, existing ? "current" : "saved");
    assert.equal(threads[0].messages[0].parts[0].complete, true);
    assert.equal(readFileSync(join(directory, existing ? ".loom" : ".citropy", "threads", "saved.json"), "utf8"), saved);
    assert.equal(existsSync(join(directory, ".loom")), existing);
  }
});

test("the earlier Lemon folders become the shared ones without overwriting data", (t) => {
  const directory = temporary(t);
  write(join(directory, "Citropy Lemon", "window.json"), '{"width":1280}');
  assert.equal(migrateDesktopData(directory), join(directory, "Citropy"));
  assert.equal(existsSync(join(directory, "Citropy Lemon")), false);
  assert.equal(readFileSync(join(directory, "Citropy", "window.json"), "utf8"), '{"width":1280}');
  const both = temporary(t);
  write(join(both, "Citropy Lemon", "window.json"), "lemon");
  write(join(both, "Citropy", "window.json"), "current");
  migrateDesktopData(both);
  assert.equal(readFileSync(join(both, "Citropy", "window.json"), "utf8"), "current");
  assert.equal(readFileSync(join(both, "Citropy Lemon", "window.json"), "utf8"), "lemon");
});

test("conversations from the earlier Lemon data folder move into the shared folder once", (t) => {
  for (const existing of [false, true]) {
    const directory = temporary(t);
    const saved = JSON.stringify({ id: "saved", projectId: "workspace", status: "idle", running: false, messages: [{ id: "response", role: "assistant", parts: [{ id: "text", kind: "text", text: "Preserved response", complete: false }] }] });
    write(join(directory, ".citropy-lemon", "threads", "saved.json"), saved);
    if (existing) write(join(directory, ".citropy", "threads", "current.json"), saved.replace('"saved"', '"current"'));
    const result = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `const { store } = await import(${JSON.stringify(new URL("../server/store.ts", import.meta.url).href)}); process.stdout.write(JSON.stringify([...store.threads.values()]));`], { env: { ...process.env, HOME: directory }, encoding: "utf8" });
    const threads = JSON.parse(result);
    assert.equal(threads.length, 1);
    assert.equal(threads[0].id, existing ? "current" : "saved");
    assert.equal(existsSync(join(directory, ".citropy-lemon")), existing);
  }
});

test("the interface brand color matches the yellow mark, not Lime", () => {
  const root = new URL("..", import.meta.url);
  const mark = readFileSync(new URL("public/citropy.svg", root), "utf8");
  const tokens = readFileSync(new URL("web/src/styles/tokens.css", root), "utf8");
  assert.match(mark, /A yellow lemon half/);
  assert.match(mark, /fill="#F4D34E"/);
  assert.doesNotMatch(mark, /a3e635|lime half/i);
  assert.match(tokens, /--brand:\s*#f4d34e/i);
  assert.doesNotMatch(tokens, /a3e635|bef264|4d7c0f/i);
  const installer = readFileSync(new URL("scripts/install.sh", root), "utf8");
  assert.match(installer, /gtk-update-icon-cache -f/);
  assert.match(readFileSync(new URL("desktop/install.mjs", root), "utf8"), /gtk-update-icon-cache/);
  assert.equal(existsSync(new URL("web/src/components/ChannelBadge.tsx", root)), false);
  assert.equal(existsSync(new URL("web/src/components/ChannelSwitch.tsx", root)), false);
  assert.doesNotMatch(readFileSync(new URL("web/src/components/Titlebar.tsx", root), "utf8"), /channel-badge|ChannelBadge|Lime/);
  assert.doesNotMatch(readFileSync(new URL("web/src/styles/app.css", root), "utf8"), /channel-badge/);
});
