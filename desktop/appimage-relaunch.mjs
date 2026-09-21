import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./apply-appimage-update.sh", import.meta.url));

function absolutePath(value, label) {
  if (typeof value !== "string" || !value || !isAbsolute(value) || /[\0\r\n]/.test(value))
    throw new Error(`${label} must be an absolute path.`);
  return value;
}

export function spawnAppImageRelaunch({
  appImage,
  downloadedFile,
  parentPid,
  logFile,
}) {
  const dest = absolutePath(appImage, "The installed AppImage");
  const source =
    downloadedFile === undefined
      ? undefined
      : absolutePath(downloadedFile, "The downloaded update");
  const log = absolutePath(logFile, "The update log");
  if (source && dest === source) throw new Error("The downloaded update cannot replace itself in place.");
  if (!Number.isInteger(parentPid) || parentPid <= 0)
    throw new Error("The running Citropy process id is missing.");
  const stream = openSync(log, "a");
  try {
    const env = {
      ...process.env,
      CITROPY_APPIMAGE: dest,
      CITROPY_PARENT_PID: String(parentPid),
    };
    if (source) env.CITROPY_UPDATE_FILE = source;
    else delete env.CITROPY_UPDATE_FILE;
    const child = spawn("/bin/sh", [script], {
      detached: true,
      stdio: ["ignore", stream, stream],
      env,
      cwd: dirname(dest),
    });
    child.unref();
    if (!child.pid) throw new Error("Could not start the update relaunch helper.");
    return child.pid;
  } finally {
    closeSync(stream);
  }
}
