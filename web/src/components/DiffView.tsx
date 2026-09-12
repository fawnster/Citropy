import { useEffect, useMemo, useState } from "react";
import { highlightTokens, escapeHtml } from "../lib/highlight.ts";
import { langFor } from "../lib/format.ts";
import { useApp } from "../lib/store.ts";
import { useDisclosure } from "../lib/use-disclosure.ts";
import type { FilePatch, PatchLine } from "../../../shared/protocol.ts";

interface Props {
  patch: FilePatch;
  limit?: number;
  showHeader?: boolean;
  partId?: string;
}

interface Row extends PatchLine {
  key: string;
  side: "old" | "new" | "both";
  index: number;
}

function rows(patch: FilePatch): Row[] {
  const out: Row[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  patch.hunks.forEach((hunk, h) => {
    hunk.lines.forEach((line, l) => {
      if (line.text === "…" && line.oldNo === undefined && line.newNo === undefined) {
        out.push({ ...line, key: `${h}-${l}`, side: "both", index: -1 });
        return;
      }
      if (line.type === "del") {
        out.push({ ...line, key: `${h}-${l}`, side: "old", index: oldIndex });
        oldIndex += 1;
      } else if (line.type === "add") {
        out.push({ ...line, key: `${h}-${l}`, side: "new", index: newIndex });
        newIndex += 1;
      } else {
        out.push({ ...line, key: `${h}-${l}`, side: "both", index: newIndex });
        oldIndex += 1;
        newIndex += 1;
      }
    });
  });
  return out;
}

export function DiffView({ patch, limit = 26, showHeader = true, partId }: Props) {
  const theme = useApp((state) => state.theme);
  const [expanded, setExpanded] = useDisclosure(partId, "diff");
  const [oldLines, setOldLines] = useState<string[] | null>(null);
  const [newLines, setNewLines] = useState<string[] | null>(null);

  const all = useMemo(() => rows(patch), [patch]);
  const visible = useMemo(() => expanded ? all : all.slice(0, limit), [all, expanded, limit]);
  const lang = langFor(patch.path);

  useEffect(() => {
    let cancelled = false;
    const oldText = visible
      .filter((row) => row.side !== "new" && row.index >= 0)
      .map((row) => row.text)
      .join("\n");
    const newText = visible
      .filter((row) => row.side !== "old" && row.index >= 0)
      .map((row) => row.text)
      .join("\n");
    void Promise.all([
      highlightTokens(oldText, lang, theme),
      highlightTokens(newText, lang, theme),
    ]).then(([older, newer]) => {
      if (cancelled) return;
      setOldLines(older);
      setNewLines(newer);
    });
    return () => {
      cancelled = true;
    };
  }, [visible, lang, theme]);

  const hidden = all.length - visible.length;

  const render = (row: Row): string => {
    if (row.index < 0) return escapeHtml(row.text);
    const source = row.side === "old" ? oldLines : newLines;
    const line = source?.[row.index];
    if (line !== undefined) return line;
    return escapeHtml(row.text);
  };

  return (
    <div className="diff">
      {showHeader && (
        <div className="diff-head">
          <span className="diff-path truncate">{patch.path}</span>
          <span className="diff-stat">
            {patch.added > 0 && <span className="diff-plus">+{patch.added}</span>}
            {patch.removed > 0 && <span className="diff-minus">-{patch.removed}</span>}
          </span>
        </div>
      )}
      <div className="diff-body">
        {visible.map((row) => (
          <div className="diff-line" data-type={row.type} key={row.key}>
            <span className="diff-no">{row.oldNo ?? ""}</span>
            <span className="diff-no">{row.newNo ?? ""}</span>
            <span className="diff-sign">{row.type === "add" ? "+" : row.type === "del" ? "-" : " "}</span>
            <span className="diff-code" dangerouslySetInnerHTML={{ __html: render(row) }} />
          </div>
        ))}
      </div>
      {hidden > 0 && (
        <button className="diff-more" type="button" onClick={() => setExpanded(true)}>
          Show {hidden} more {hidden === 1 ? "line" : "lines"}
        </button>
      )}
      {patch.truncated && <div className="diff-more" data-static="true">Diff truncated</div>}
    </div>
  );
}
