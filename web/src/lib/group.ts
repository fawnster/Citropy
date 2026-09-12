import type { Part, ToolPart, ToolShape } from "../../../shared/protocol.ts";
import { translate } from "./i18n.ts";
import type { Translator } from "./translations.ts";

export type Row = { kind: "part"; id: string } | { kind: "group"; ids: string[] };

const STANDALONE = new Set<ToolShape>(["edit", "write"]);

export function buildRows(parts: Array<Part | undefined>): Row[] {
  const rows: Row[] = [];
  let batch: string[] = [];

  const flush = () => {
    if (batch.length === 0) return;
    rows.push({ kind: "group", ids: batch });
    batch = [];
  };

  for (const part of parts) {
    if (!part) continue;
    if ((part.kind === "text" || part.kind === "reasoning") && part.text.trim() === "") continue;
    if (part.kind === "tool" && !STANDALONE.has(part.shape)) {
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
