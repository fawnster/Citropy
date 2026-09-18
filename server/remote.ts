import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { stat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const remoteId = process.env.CITROPY_REMOTE_ID;
const token = process.env.CITROPY_REMOTE_TOKEN;
if (remoteId && (!token || token.length < 64 || (process.env.CITROPY_HOST !== "127.0.0.1" && !(process.env.CITROPY_CONTAINER === "1" && process.env.CITROPY_HOST === "0.0.0.0"))))
  throw new Error("Remote environments require authentication and a loopback listener.");

export function authorizeRemote(req: IncomingMessage): boolean {
  if (!remoteId) return true;
  const value = req.headers["x-citropy-remote-token"];
  if (typeof value !== "string" || !token) return false;
  const supplied = Buffer.from(value);
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function workspaceDirectory(input: string): Promise<string> {
  const path = await realpath(input === "~" || !input ? homedir() : input.startsWith("~/") ? resolve(homedir(), input.slice(2)) : resolve(input));
  if (!(await stat(path)).isDirectory()) throw new Error("Choose a folder for the workspace.");
  return path;
}
