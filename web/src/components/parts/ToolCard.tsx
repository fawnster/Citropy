import { useMemo, useState } from "react";
import { Collapsible } from "../Collapsible.tsx";
import { AlertTriangle, Ban, Check, ChevronRight, ExternalLink, shapeIcon } from "../icons.ts";
import { DiffView } from "../DiffView.tsx";
import { ansiToHtml, stripAnsi } from "../../lib/ansi.ts";
import { duration } from "../../lib/format.ts";
import type { ToolPart } from "../../../../shared/protocol.ts";

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
};

function label(name: string, status: ToolPart["status"]): string {
  const pair = VERBS[name];
  if (!pair) {
    const short = name.startsWith("mcp__") ? (name.split("__")[1] ?? "tool") : name;
    return status === "running" ? `Running ${short}` : short;
  }
  if (status === "denied") return `Blocked ${pair[1].toLowerCase()}`;
  return status === "running" ? pair[0] : pair[1];
}

export function ToolCard({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(Boolean(part.patch));
  const Icon = shapeIcon[part.shape];
  const elapsed = part.endedAt ? part.endedAt - part.startedAt : null;
  const output = part.output ?? "";

  const peek = useMemo(() => {
    if (part.status === "running") return null;
    if (part.patch) return null;
    const clean = stripAnsi(output).trim();
    if (!clean) return null;
    const first = clean.split("\n").find((line) => line.trim().length > 0) ?? "";
    return first.length > 120 ? `${first.slice(0, 120)}…` : first;
  }, [output, part.patch, part.status]);

  const url = part.shape === "web" ? part.headline : null;

  return (
    <div className="tool" data-shape={part.shape} data-status={part.status} data-open={open}>
      <button className="tool-head" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ChevronRight size={12} className="tool-chevron" />
        <span className="tool-icon">
          <Icon size={13} />
        </span>
        <span className="tool-name">{label(part.name, part.status)}</span>
        <span className="tool-headline mono truncate">{part.headline}</span>
        <span className="tool-meta">
          {part.detail && <span className="tool-detail truncate">{part.detail}</span>}
          {part.patch && (
            <span className="tool-stat">
              {part.patch.added > 0 && <span className="diff-plus">+{part.patch.added}</span>}
              {part.patch.removed > 0 && <span className="diff-minus">-{part.patch.removed}</span>}
            </span>
          )}
          {elapsed !== null && elapsed > 400 && <span className="tool-time">{duration(elapsed)}</span>}
          <StatusMark status={part.status} />
        </span>
      </button>

      {!open && peek && <div className="tool-peek mono truncate">{peek}</div>}

      <Collapsible open={open} className="tool-body">
        <div className="tool-body-inner">
          {url && (
            <a className="tool-url mono truncate" href={url} target="_blank" rel="noreferrer noopener">
              {url}
              <ExternalLink size={11} />
            </a>
          )}
          {part.patch && <DiffView patch={part.patch} showHeader={false} />}
          {!part.patch && output && <Output text={output} shape={part.shape} />}
          {!part.patch && !output && part.status === "running" && (
            <div className="tool-waiting">
              <span className="tool-waiting-bar" />
              Running
            </div>
          )}
          {!part.patch && !output && part.status !== "running" && (
            <div className="tool-empty">No output</div>
          )}
        </div>
      </Collapsible>
    </div>
  );
}

function StatusMark({ status }: { status: ToolPart["status"] }) {
  if (status === "running") return <span className="tool-spin" aria-label="running" />;
  if (status === "ok") return <Check size={12} className="tool-ok" aria-label="done" />;
  if (status === "denied") return <Ban size={12} className="tool-bad" aria-label="denied" />;
  return <AlertTriangle size={12} className="tool-bad" aria-label="failed" />;
}

function Output({ text, shape }: { text: string; shape: ToolPart["shape"] }) {
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => text.split("\n"), [text]);
  const cap = shape === "command" ? 18 : 14;
  const shown = expanded ? lines : lines.slice(0, cap);
  const hidden = lines.length - shown.length;
  const html = useMemo(() => ansiToHtml(shown.join("\n")), [shown]);

  return (
    <>
      <pre className="tool-output" dangerouslySetInnerHTML={{ __html: html }} />
      {hidden > 0 && (
        <button className="diff-more" type="button" onClick={() => setExpanded(true)}>
          Show {hidden} more {hidden === 1 ? "line" : "lines"}
        </button>
      )}
    </>
  );
}
