import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ProviderId } from "../../shared/protocol.ts";
import type { GlobalInstructions } from "../../shared/provider-settings.ts";

const MAX_BYTES = 64 * 1024;

export function readGlobalInstructions(
  provider: ProviderId,
): GlobalInstructions {
  let path: string;
  let note: string | undefined;
  if (provider === "claude") {
    path = join(
      process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
      "CLAUDE.md",
    );
  } else if (provider === "codex") {
    const home = process.env.CODEX_HOME || join(homedir(), ".codex");
    const override = join(home, "AGENTS.override.md");
    path = existsSync(override) ? override : join(home, "AGENTS.md");
    if (path === override)
      note =
        "AGENTS.override.md takes precedence over AGENTS.md when it contains instructions.";
  } else if (provider === "opencode") {
    path = join(
      process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
      "opencode",
      "AGENTS.md",
    );
    note =
      "OpenCode uses this file for global rules. Creating it replaces the Claude Code fallback, if your OpenCode version uses that fallback.";
  } else {
    throw new Error("Unknown provider.");
  }
  path = resolve(path);
  let content = "";
  let exists = false;
  let target = path;
  try {
    target = realpathSync(path);
    const file = openSync(target, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(file);
      if (!stat.isFile())
        throw new Error("The instruction path must be a file.");
      if (stat.size > MAX_BYTES)
        throw new Error(
          "This instruction file is larger than 64 KB. Edit it in your file editor.",
        );
      content = readFileSync(file, "utf8");
      exists = true;
    } finally {
      closeSync(file);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error(
        "This instruction file links to a missing file. Restore its target before editing.",
      );
  }
  const revision = createHash("sha256")
    .update(JSON.stringify([path, target, exists, content]))
    .digest("hex");
  return { provider, path, exists, content, revision, note };
}

export function saveGlobalInstructions(
  provider: ProviderId,
  content: unknown,
  revision: unknown,
): GlobalInstructions {
  if (
    typeof content !== "string" ||
    Buffer.byteLength(content, "utf8") > MAX_BYTES ||
    content.includes("\0")
  )
    throw new Error("Instructions must be text smaller than 64 KB.");
  const current = readGlobalInstructions(provider);
  if (typeof revision !== "string" || revision !== current.revision)
    throw new Error(
      "This file changed outside this editor. Reload the file before saving; your draft is still here.",
    );
  if (current.exists && content === current.content) return current;
  const target = current.exists ? realpathSync(current.path) : current.path;
  mkdirSync(dirname(target), { recursive: true });
  const temporary = join(
    dirname(target),
    `.citropy-instructions-${randomUUID()}`,
  );
  const backup = `${temporary}-backup`;
  try {
    writeFileSync(temporary, content, {
      flag: "wx",
      mode: current.exists ? statSync(target).mode & 0o777 : 0o600,
    });
    if (current.exists) {
      copyFileSync(target, backup, constants.COPYFILE_EXCL);
      renameSync(backup, `${target}.citropy-backup`);
    }
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
    rmSync(backup, { force: true });
  }
  return readGlobalInstructions(provider);
}
