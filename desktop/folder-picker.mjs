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

export async function chooseNativeFolder({ connection, path, signal }, showOpenDialog) {
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
      if (connection) throw new Error("Remote folders need the system's SFTP folder chooser. Install kdialog and the KDE SFTP support, then try again.");
    }
  }
  if (value === undefined) {
    if (connection) throw new Error("The system folder chooser needs SFTP support to browse SSH workspaces.");
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
