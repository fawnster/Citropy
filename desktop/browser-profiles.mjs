import { readdir, readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import {
  randomUUID,
  createHash,
  pbkdf2Sync,
  createDecipheriv,
} from "node:crypto";
import { isUtf8 } from "node:buffer";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
let preferences = {};
let file;
let operations = Promise.resolve();

export async function initializeProfiles(userData) {
  await mkdir(userData, { recursive: true });
  file = join(userData, "browser-profiles.json");
  try {
    preferences = JSON.parse(await readFile(file, "utf8"));
  } catch {
    preferences = {};
  }
}

async function save() {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(preferences), { mode: 0o600 });
  await rename(temporary, file);
}

function projectProfiles(projectId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) throw new Error("Invalid workspace");
  preferences[projectId] ??= {
    selected: "workspace",
    profiles: [{ id: "workspace", name: "Workspace" }],
  };
  return preferences[projectId];
}

export function browserProfile(projectId, profileId) {
  const settings = projectProfiles(projectId);
  const profile = settings.profiles.find(
    (entry) => entry.id === (profileId ?? settings.selected),
  );
  if (!profile) throw new Error("Browser profile not found");
  return {
    ...profile,
    partition:
      profile.id === "workspace"
        ? `persist:citropy-${projectId}`
        : `persist:citropy-${projectId}-${profile.id}`,
  };
}

async function sources() {
  const home = homedir();
  const linux = process.platform === "linux";
  const chromeRoot = linux
    ? join(home, ".config")
    : process.platform === "darwin"
      ? join(home, "Library/Application Support")
      : process.env.LOCALAPPDATA;
  const locations = chromeRoot
    ? [
        ["Chrome", linux ? "google-chrome" : "Google/Chrome", "chrome"],
        ["Chromium", linux ? "chromium" : "Chromium", "chromium"],
        [
          "Brave",
          linux ? "BraveSoftware/Brave-Browser" : "BraveSoftware/Brave-Browser",
          "brave",
        ],
        ["Edge", linux ? "microsoft-edge" : "Microsoft Edge", "microsoft-edge"],
        ["Vivaldi", linux ? "vivaldi" : "Vivaldi", "vivaldi"],
        ["Helium", linux ? "helium" : "Helium", "helium"],
      ]
    : [];
  const result = [];
  if (process.platform !== "win32")
    for (const [browser, relative, application] of locations) {
      const root = join(chromeRoot, relative);
      const entries = await readdir(root, { withFileTypes: true }).catch(
        () => [],
      );
      let names = {};
      try {
        names =
          JSON.parse(await readFile(join(root, "Local State"), "utf8")).profile
            ?.info_cache ?? {};
      } catch {}
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^(Default|Profile \d+)$/.test(entry.name))
          continue;
        const path = [
          join(root, entry.name, "Network/Cookies"),
          join(root, entry.name, "Cookies"),
        ].find(existsSync);
        if (path)
          result.push({
            id: createHash("sha256").update(path).digest("hex").slice(0, 24),
            name: `${browser} · ${names[entry.name]?.name || entry.name}`,
            browser,
            path,
            application,
            engine: "chromium",
          });
      }
    }
  const firefoxRoot = linux
    ? join(home, ".mozilla/firefox")
    : process.platform === "darwin"
      ? join(home, "Library/Application Support/Firefox/Profiles")
      : join(process.env.APPDATA || home, "Mozilla/Firefox/Profiles");
  for (const entry of await readdir(firefoxRoot, { withFileTypes: true }).catch(
    () => [],
  )) {
    const path = join(firefoxRoot, entry.name, "cookies.sqlite");
    if (entry.isDirectory() && existsSync(path))
      result.push({
        id: createHash("sha256").update(path).digest("hex").slice(0, 24),
        name: `Firefox · ${entry.name}`,
        browser: "Firefox",
        path,
        engine: "firefox",
      });
  }
  return result;
}

export function decryptCookie(encrypted, host, version, keys) {
  const buffer = Buffer.from(encrypted);
  const prefix = buffer.subarray(0, 3).toString();
  if (!["v10", "v11"].includes(prefix)) return null;
  const key = keys[prefix];
  if (!key) return null;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
    let plain = Buffer.concat([
      decipher.update(buffer.subarray(3)),
      decipher.final(),
    ]);
    if (version >= 24) {
      if (
        !plain
          .subarray(0, 32)
          .equals(createHash("sha256").update(host).digest())
      )
        return null;
      plain = plain.subarray(32);
    }
    return isUtf8(plain) ? plain.toString("utf8") : null;
  } catch {
    return null;
  }
}

async function readCookies(source) {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(source.path, {
    readOnly: true,
    timeout: 3000,
  });
  let rows;
  let version = 0;
  try {
    database.exec("BEGIN");
    rows = database
      .prepare(
        source.engine === "firefox"
          ? "SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, originAttributes FROM moz_cookies LIMIT 50000"
          : "SELECT * FROM cookies LIMIT 50000",
      )
      .all();
    if (source.engine === "chromium")
      version = Number(
        database.prepare("SELECT value FROM meta WHERE key = 'version'").get()
          ?.value || 0,
      );
    database.exec("ROLLBACK");
  } finally {
    database.close();
  }
  const keys = { v10: pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1") };
  if (source.engine === "chromium") {
    const needsSecret =
      process.platform === "darwin" ||
      rows.some(
        (row) =>
          Buffer.from(row.encrypted_value).subarray(0, 3).toString() === "v11",
      );
    if (needsSecret) {
      const result = await (
        process.platform === "darwin"
          ? run(
              "security",
              [
                "find-generic-password",
                "-w",
                "-s",
                `${source.browser} Safe Storage`,
              ],
              { timeout: 30_000, maxBuffer: 4096 },
            )
          : run("secret-tool", ["lookup", "application", source.application], {
              timeout: 30_000,
              maxBuffer: 4096,
            })
      ).catch(() => null);
      if (result?.stdout)
        keys[process.platform === "darwin" ? "v10" : "v11"] = pbkdf2Sync(
          result.stdout.replace(/\r?\n$/, ""),
          "saltysalt",
          process.platform === "darwin" ? 1003 : 1,
          16,
          "sha1",
        );
    }
  }
  const cookies = [];
  let skipped = 0;
  for (const row of rows) {
    const firefox = source.engine === "firefox";
    if (
      firefox
        ? row.originAttributes
        : row.top_frame_site_key || row.partition_key
    ) {
      skipped++;
      continue;
    }
    const host = firefox ? row.host : row.host_key;
    const value =
      firefox || row.value
        ? row.value
        : decryptCookie(row.encrypted_value, host, version, keys);
    if (value === null) {
      skipped++;
      continue;
    }
    const secure = Boolean(firefox ? row.isSecure : row.is_secure);
    const expirationDate = firefox
      ? Number(row.expiry)
      : Number(row.expires_utc) / 1_000_000 - 11644473600;
    if (expirationDate > 0 && expirationDate < Date.now() / 1000) {
      skipped++;
      continue;
    }
    const cookie = {
      url: `${secure ? "https" : "http"}://${host.replace(/^\./, "")}${row.path || "/"}`,
      name: row.name,
      value,
      path: row.path || "/",
      secure,
      httpOnly: Boolean(firefox ? row.isHttpOnly : row.is_httponly),
      sameSite:
        { 0: "no_restriction", 1: "lax", 2: "strict" }[
          firefox ? row.sameSite : row.samesite
        ] || "unspecified",
    };
    if (host.startsWith(".") && !row.name.startsWith("__Host-"))
      cookie.domain = host;
    if (expirationDate > 0) cookie.expirationDate = expirationDate;
    cookies.push(cookie);
  }
  return { cookies, skipped };
}

export function handleProfiles(operation, input, session, tabs) {
  const result = operations.then(() =>
    applyProfiles(operation, input, session, tabs),
  );
  operations = result.then(
    () => {},
    () => {},
  );
  return result;
}

async function applyProfiles(operation, input, session, tabs) {
  const settings = projectProfiles(input.projectId);
  const getSession = (id) =>
    session.fromPartition(browserProfile(input.projectId, id).partition);
  if (operation === "sources")
    return (await sources()).map(({ id, name, browser }) => ({
      id,
      name,
      browser,
    }));
  if (operation === "profiles") {
    if (input.method === "POST") {
      if (input.selected) {
        browserProfile(input.projectId, input.selected);
        settings.selected = input.selected;
      } else {
        const name = String(input.name || "")
          .trim()
          .slice(0, 60);
        if (!name) throw new Error("Enter a profile name.");
        if (settings.profiles.length >= 20)
          throw new Error("Keep up to 20 profiles per workspace.");
        const id = randomUUID();
        settings.profiles.push({ id, name });
        settings.selected = id;
      }
      await save();
    } else if (input.method === "DELETE") {
      if (input.id === "workspace")
        throw new Error("The workspace profile cannot be deleted.");
      browserProfile(input.projectId, input.id);
      if (
        [...tabs.values()].some(
          (tab) =>
            tab.state.projectId === input.projectId &&
            tab.state.profileId === input.id,
        )
      )
        throw new Error("Close this profile's browser tabs first.");
      await getSession(input.id).clearStorageData();
      await getSession(input.id).clearCache();
      settings.profiles = settings.profiles.filter(
        (entry) => entry.id !== input.id,
      );
      if (settings.selected === input.id) settings.selected = "workspace";
      await save();
    }
    return {
      selected: settings.selected,
      profiles: await Promise.all(
        settings.profiles.map(async (profile) => ({
          ...profile,
          projectId: input.projectId,
          cookies: (await getSession(profile.id).cookies.get({})).length,
          activeTabs: [...tabs.values()].filter(
            (tab) =>
              tab.state.projectId === input.projectId &&
              (tab.state.profileId || "workspace") === profile.id,
          ).length,
        })),
      ),
    };
  }
  const target = getSession(input.profileId || settings.selected);
  if (operation === "clear") {
    if (input.kind === "cookies")
      await target.clearStorageData({ storages: ["cookies"] });
    else if (input.kind === "cache") await target.clearCache();
    else throw new Error("Select cookies or cache.");
    return { ok: true };
  }
  if (operation === "import") {
    const source = (await sources()).find(
      (entry) => entry.id === input.sourceId,
    );
    if (!source) throw new Error("Source browser profile not found.");
    const data = await readCookies(source);
    let imported = 0;
    let skipped = data.skipped;
    for (let index = 0; index < data.cookies.length; index += 50)
      await Promise.all(
        data.cookies.slice(index, index + 50).map(async (cookie) => {
          try {
            await target.cookies.set(cookie);
            imported++;
          } catch {
            skipped++;
          }
        }),
      );
    await target.cookies.flushStore();
    return { imported, skipped };
  }
  throw new Error("Unknown browser profile action");
}
