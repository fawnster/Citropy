import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";

/**
 * Resolve a provider CLI name (for example `cursor-agent`) to something `spawn` can run on this
 * platform. On Linux and macOS this is the bare name. On Windows the CLIs are `.ps1` / `.cmd`
 * launchers that Node cannot spawn directly, so the result carries the interpreter and arguments.
 *
 * Also consulted for GUI launches where PATH is minimal (~/.local/bin, ~/.opencode/bin, Homebrew).
 */
export interface ResolvedCommand {
  /** Executable to hand to `spawn`. */
  file: string;
  /** Arguments to put before the caller's own arguments. */
  prefix: string[];
  /** Where the CLI was found, for update planning and diagnostics. */
  path?: string;
}

export function resolveCommand(binary: string): ResolvedCommand {
  return { file: binary, prefix: [] };
}

/** `spawn` a provider CLI by name using `resolveCommand`. */
export function spawnCommand(
  binary: string,
  args: string[],
  options: SpawnOptions,
): ChildProcessWithoutNullStreams {
  const resolved = resolveCommand(binary);
  return spawn(resolved.file, [...resolved.prefix, ...args], options) as ChildProcessWithoutNullStreams;
}
