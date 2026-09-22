import type { Part, ToolPart, ToolShape } from "../../../shared/protocol.ts";
import { isQuestionTool } from "../../../shared/questions.ts";
import { normalizeTodos } from "../../../shared/todos.ts";
import { translate } from "./i18n.ts";
import type { Translator } from "./translations.ts";

export type Row = { kind: "part"; id: string } | { kind: "group"; ids: string[] } | { kind: "thoughts"; ids: string[] };

export function buildRows(parts: Array<Part | undefined>): Row[] {
  const rows: Row[] = [];
  const hasQuestion = parts.some(part => part?.kind === "question");
  let batch: string[] = [];
  let batchKind: "group" | "thoughts" = "group";

  const flush = () => {
    if (batch.length === 0) return;
    rows.push({ kind: batchKind, ids: batch });
    batch = [];
  };

  for (const part of parts) {
    if (!part) continue;
    if ((part.kind === "text" || part.kind === "reasoning") && part.text.trim() === "") continue;
    if (part.kind === "todo" && normalizeTodos(part.items).length === 0) continue;
    if (part.kind === "tool" || part.kind === "reasoning") {
      if (part.kind === "tool" && hasQuestion && isQuestionTool(part.name)) continue;
      if (part.kind === "tool" && (part.images?.length || part.imageFiles?.length)) {
        flush();
        rows.push({ kind: "part", id: part.id });
        continue;
      }
      const kind = part.kind === "tool" ? "group" : "thoughts";
      if (kind !== batchKind) flush();
      batchKind = kind;
      batch.push(part.id);
      continue;
    }
    flush();
    rows.push({ kind: "part", id: part.id });
  }
  flush();
  return rows;
}

const NOUN: Record<ToolShape, [string, string, string]> = {
  read: ["Read", "file", "files"],
  write: ["Wrote", "file", "files"],
  edit: ["Changed", "file", "files"],
  command: ["Ran", "command", "commands"],
  search: ["Searched code", "time", "times"],
  web: ["Searched the web", "time", "times"],
  computer: ["Used the computer", "time", "times"],
  task: ["Ran", "subagent", "subagents"],
  todo: ["Updated", "plan", "plans"],
  generic: ["Used", "tool", "tools"],
};

function phrase(shape: ToolShape, count: number, t: Translator): string {
  const [verb, one, many] = NOUN[shape];
  return `${t(verb, undefined, "summary")} ${count} ${t(count === 1 ? one : many)}`;
}

export function summarize(tools: ToolPart[], t: Translator = translate): string {
  const counts = new Map<ToolShape, Set<string>>();
  const plain = new Map<ToolShape, number>();

  for (const tool of tools) {
    if (tool.shape === "read" || tool.shape === "edit" || tool.shape === "write") {
      const set = counts.get(tool.shape) ?? new Set<string>();
      set.add(tool.headline);
      counts.set(tool.shape, set);
      continue;
    }
    plain.set(tool.shape, (plain.get(tool.shape) ?? 0) + 1);
  }

  const parts: string[] = [];
  const order: ToolShape[] = ["read", "edit", "write", "command", "search", "web", "computer", "task", "generic", "todo"];
  for (const shape of order) {
    const unique = counts.get(shape);
    if (unique) parts.push(phrase(shape, unique.size, t));
    const count = plain.get(shape);
    if (count) parts.push(phrase(shape, count, t));
  }

  if (parts.length === 0) return t("Worked");
  const sentence = parts.map((text, index) =>
    index === 0 ? text : `${text.charAt(0).toLowerCase()}${text.slice(1)}`,
  );
  if (sentence.length === 1) return sentence[0] as string;
  return t("{first} and {last}", { first: sentence.slice(0, -1).join(", "), last: sentence.at(-1)! });
}

export function groupStats(tools: ToolPart[]): { added: number; removed: number; failed: number; running: boolean } {
  let added = 0;
  let removed = 0;
  let failed = 0;
  let running = false;
  for (const tool of tools) {
    if (tool.patch) {
      added += tool.patch.added;
      removed += tool.patch.removed;
    }
    if (tool.status === "error" || tool.status === "denied") failed += 1;
    if (tool.status === "running") running = true;
  }
  return { added, removed, failed, running };
}

const VERBS: Record<string, [string, string]> = {
  Bash: ["Running", "Ran"],
  Read: ["Reading", "Read"],
  Write: ["Writing", "Wrote"],
  Edit: ["Editing", "Edited"],
  MultiEdit: ["Editing", "Edited"],
  NotebookEdit: ["Editing", "Edited"],
  Glob: ["Finding", "Found"],
  Grep: ["Searching", "Searched"],
  WebSearch: ["Searching the web for", "Searched the web for"],
  WebFetch: ["Fetching", "Fetched"],
  Task: ["Delegating", "Delegated"],
  Agent: ["Delegating", "Delegated"],
  citropy_terminal_open: ["Opening terminal", "Opened terminal"],
  citropy_terminal_read: ["Reading terminal output", "Read terminal output"],
  citropy_terminal_write: ["Writing to terminal", "Wrote to terminal"],
};

export function toolLabel(name: string, status: ToolPart["status"], t: Translator = translate): string {
  const pair = VERBS[name];
  if (!pair) {
    const short = (name.startsWith("mcp__") ? name.split("__").slice(2).join(" ") || name : name).replaceAll("_", " ");
    return status === "running" ? `${t("Running")} ${short}` : short;
  }
  if (status === "denied") return `${t("Blocked")} ${t(pair[1]).toLowerCase()}`;
  return status === "running"
    ? t(pair[0])
    : t(pair[1], undefined, "past");
}
