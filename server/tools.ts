import { basename, dirname, relative, isAbsolute } from "node:path";
import type { ToolShape } from "../shared/protocol.ts";

export interface ToolDescription {
  shape: ToolShape;
  headline: string;
  detail?: string;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function firstLine(value: string, max = 160): string {
  const line = value.split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function shorten(value: string, root: string): string {
  if (!root) return value;
  return value.split(`${root}/`).join("").split(root).join(".");
}

function folder(path: string, root: string): string | undefined {
  if (!path) return undefined;
  const dir = dirname(path);
  if (!root || !isAbsolute(path)) return dir === "." ? undefined : dir;
  const rel = relative(root, dir);
  if (rel === "") return undefined;
  if (rel.startsWith("..")) return dir;
  return rel;
}

export function describeTool(name: string, rawInput: unknown, root = ""): ToolDescription {
  const input = (rawInput ?? {}) as Record<string, unknown>;
  const path =
    str(input.file_path) ||
    str(input.filePath) ||
    str(input.notebook_path) ||
    str(input.path);
  const short = path ? basename(path) : "";
  const dir = folder(path, root);

  const computer = name.replace(/^(?:mcp__citropy__|citropy_)/, "");
  if (computer.startsWith("computer_")) {
    const headlines: Record<string, string> = {
      computer_help: "Read computer-use instructions",
      computer_status: "Check desktop session",
      computer_start: "Share the desktop",
      computer_screenshot: "Inspect the desktop",
      computer_stop: "Stop desktop sharing",
    };
    const headline = computer === "computer_action"
      ? input.action === "type" ? `Type ${str(input.text).length} characters` : input.action === "press" ? `Press ${str(input.key)}` : `${str(input.action) || "Use"} on the desktop`
      : headlines[computer] ?? "Use the desktop";
    return { shape: "computer", headline: headline[0]!.toUpperCase() + headline.slice(1) };
  }

  switch (name) {
    case "Bash":
    case "BashOutput":
    case "Shell":
      return {
        shape: "command",
        headline: firstLine(shorten(str(input.command), root)) || name,
        detail: str(input.description) || undefined,
      };
    case "Read":
      return { shape: "read", headline: short || "file", detail: dir };
    case "Write":
      return { shape: "write", headline: short || "file", detail: dir };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { shape: "edit", headline: short || "file", detail: dir };
    case "Glob":
      return { shape: "search", headline: str(input.pattern) || "glob", detail: str(input.path) || undefined };
    case "Grep":
      return {
        shape: "search",
        headline: str(input.pattern) || "search",
        detail: [str(input.path), str(input.glob)].filter(Boolean).join(" ") || undefined,
      };
    case "WebSearch":
      return { shape: "web", headline: str(input.query) || "search", detail: "web search" };
    case "WebFetch":
      return { shape: "web", headline: str(input.url) || "fetch", detail: firstLine(str(input.prompt), 90) || undefined };
    case "Task":
    case "Agent":
      return {
        shape: "task",
        headline: str(input.description) || "subagent",
        detail: str(input.subagent_type) || undefined,
      };
    case "TodoWrite":
      return { shape: "todo", headline: "Plan updated" };
    case "TaskCreate":
      return { shape: "todo", headline: str(input.title) || "New task" };
    case "TaskUpdate":
      return { shape: "todo", headline: `Task ${str(input.taskId) || "?"} ${str(input.status) || "updated"}` };
    case "TaskView":
      return { shape: "todo", headline: "Plan" };
    case "ExitPlanMode":
      return { shape: "task", headline: "Plan ready for review" };
    default: {
      if (name.startsWith("mcp__")) {
        const parts = name.split("__");
        return { shape: "generic", headline: parts.slice(2).join(" ") || name, detail: parts[1] };
      }
      return { shape: "generic", headline: name, detail: firstLine(JSON.stringify(input), 90) };
    }
  }
}
