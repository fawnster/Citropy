import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { stat } from "node:fs/promises";
import { sshArguments, shellQuote } from "./ssh.mjs";

const run = promisify(execFile);

export function remoteFolderPath(value, location) {
  let selected;
  try { selected = new URL(value); }
  catch { throw new Error("Choose a folder on the selected SSH host."); }
  const expected = new URL(location.url);
  const hosts = [expected.hostname, location.hostname].map(host => host.replace(/^\[|\]$/g, "").toLowerCase());
  if (selected.protocol !== "sftp:" || selected.password || selected.search || selected.hash ||
    !hosts.includes(selected.hostname.replace(/^\[|\]$/g, "").toLowerCase()) ||
    decodeURIComponent(selected.username) !== decodeURIComponent(expected.username) ||
    (selected.port || "22") !== (expected.port || "22"))
    throw new Error("Choose a folder on the selected SSH host.");
  const path = decodeURIComponent(selected.pathname);
  if (!path.startsWith("/") || /[\r\n\0]/.test(path)) throw new Error("The selected remote folder path is invalid.");
  return path;
}

export async function remoteFolderLocation(connection, path, signal) {
  const args = sshArguments(connection);
  const { stdout } = await run("ssh", [...args, "-G", connection.target], { signal, timeout: 15000, maxBuffer: 128 * 1024 });
  const config = Object.fromEntries(stdout.split(/\r?\n/).map(line => { const space = line.indexOf(" "); return [line.slice(0, space), line.slice(space + 1)]; }));
  const target = connection.target.slice(connection.target.lastIndexOf("@") + 1);
  const url = new URL(`sftp://${target}`);
  url.username = config.user;
  url.port = config.port;
  if (path && (!path.startsWith("/") || /[\r\n\0]/.test(path))) throw new Error("Choose an absolute remote folder path.");
  if (!path) {
    const result = await run("ssh", [...args, connection.target, `sh -c ${shellQuote('printf "CITROPY_HOME %s\\n" "$HOME"')}`], { signal, timeout: 20000, maxBuffer: 64 * 1024 });
    path = result.stdout.split(/\r?\n/).find(line => line.startsWith("CITROPY_HOME "))?.slice(13);
    if (!path?.startsWith("/")) throw new Error("Could not read the SSH account's home folder.");
  }
  url.pathname = `${path.replace(/\/$/, "")}/`.split("/").map(encodeURIComponent).join("/");
  return { url: url.href, hostname: config.hostname.toLowerCase() };
}

// Lists a folder on an SSH host for Citropy's own folder browser, used where no SFTP-capable
// system chooser exists (macOS, or Linux without kdialog).
const listing = `case "$1" in "" | "~") set -- "$HOME" ;; "~/"*) set -- "$HOME/\${1#"~/"}" ;; esac
cd -- "$1" 2>/dev/null || exit 3
printf 'CITROPY_DIR %s\\0' "$(pwd)"
for entry in * .[!.]* ..?*; do [ -d "$entry" ] && printf '%s\\0' "$entry"; done
exit 0`;

export async function listRemoteFolder(connection, path = "", signal) {
  if (typeof path !== "string" || path.length > 4096 || /[\r\n\0]/.test(path) || (path && !/^(\/|~(\/|$))/.test(path)))
    throw new Error("Enter an absolute folder path on the SSH host.");
  let stdout;
  try {
    ({ stdout } = await run("ssh", [...sshArguments(connection), connection.target, `sh -c ${shellQuote(listing)} citropy ${shellQuote(path)}`], { signal, timeout: 20000, maxBuffer: 8 * 1024 * 1024 }));
  } catch (error) {
    if (error.code === 3) throw new Error("That folder does not exist on the SSH host or cannot be opened.");
    throw error;
  }
  const start = stdout.indexOf("CITROPY_DIR ");
  const [current = "", ...names] = start < 0 ? [] : stdout.slice(start + 12).split("\0");
  if (!current.startsWith("/")) throw new Error("Could not read the folder on the SSH host.");
  const folders = names.filter(name => name && !name.includes("/")).slice(0, 5000)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }))
    .map(name => ({ name, hidden: name.startsWith(".") }));
  return { path: current, parent: current === "/" ? null : current.slice(0, current.lastIndexOf("/")) || "/", folders };
}

export async function chooseNativeFolder({ connection, path, signal }, showOpenDialog) {
  signal?.throwIfAborted();
  const browse = { browse: true, path: path || "" };
  if (connection && process.platform !== "linux") return browse;
  const location = connection ? await remoteFolderLocation(connection, path, signal) : undefined;
  const title = connection ? `Open workspace on ${connection.name}` : "Open workspace in Citropy";
  let value;
  if (process.platform === "linux") {
    try {
      const result = await run("kdialog", ["--getexistingdirectory", location?.url || path || homedir(), "--title", title], { signal, maxBuffer: 64 * 1024 });
      value = result.stdout.replace(/\r?\n$/, "");
    } catch (error) {
      if (error.code === 1) return null;
      if (error.code !== "ENOENT") throw error;
      if (connection) return browse;
    }
  }
  if (value === undefined) {
    if (connection) return browse;
    const result = await showOpenDialog({ title, defaultPath: path || homedir(), properties: ["openDirectory", "createDirectory"] });
    if (result.canceled) return null;
    value = result.filePaths[0];
  }
  if (!value) return null;
  if (location) return remoteFolderPath(value, location);
  const folder = value.startsWith("file:") ? fileURLToPath(value) : value;
  if (!isAbsolute(folder) || !(await stat(folder)).isDirectory()) throw new Error("Choose a local folder for this workspace.");
  return folder;
}
