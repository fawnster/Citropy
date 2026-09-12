import { useI18n } from "../lib/i18n.ts";
import { useCallback, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { escapeHtml } from "../lib/highlight.ts";
import { langFor } from "../lib/format.ts";
import { useHighlightedLines } from "../lib/use-highlighted-lines.ts";
import { useDisclosure } from "../lib/use-disclosure.ts";
import { FileIcon } from "./FileIcon.tsx";
import type { FilePatch, PatchLine } from "../../../shared/protocol.ts";

interface Props {
  patch: FilePatch;
  limit?: number;
  showHeader?: boolean;
  partId?: string;
  expanded?: boolean;
  onExpand?: () => void;
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

export function DiffView({ patch, limit = 26, showHeader = true, partId, expanded: controlledExpanded, onExpand }: Props) {
  const t = useI18n();
  const [disclosed, setDisclosed] = useDisclosure(partId, "diff");
  const expanded = controlledExpanded ?? disclosed;
  const viewport = useRef<HTMLDivElement>(null);

  const all = useMemo(() => rows(patch), [patch]);
  const visible = useMemo(() => expanded ? all : all.slice(0, limit), [all, expanded, limit]);
  const lang = langFor(patch.path);

  const oldText = useMemo(() => visible.filter((row) => row.side !== "new" && row.index >= 0).map((row) => row.text).join("\n"), [visible]);
  const newText = useMemo(() => visible.filter((row) => row.side !== "old" && row.index >= 0).map((row) => row.text).join("\n"), [visible]);
  const oldLines = useHighlightedLines(oldText, lang);
  const newLines = useHighlightedLines(newText, lang);
  const getItemKey = useCallback((index: number) => visible[index]!.key, [visible]);
  const lines = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: visible.length,
    getScrollElement: () => viewport.current,
    getItemKey,
    estimateSize: () => 22,
    overscan: 5,
    measureElement: (element) => element.offsetHeight,
  });

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
          <FileIcon path={patch.path} />
          <span className="diff-path truncate">{patch.path}</span>
          <span className="diff-stat">
            {patch.added > 0 && <span className="diff-plus">+{patch.added}</span>}
            {patch.removed > 0 && <span className="diff-minus">-{patch.removed}</span>}
          </span>
        </div>
      )}
      <div className="diff-body scroll" ref={viewport} tabIndex={0} role="region" aria-label={t("Diff for {path}", { path: patch.path })}>
        <div className="diff-lines" style={{ height: lines.getTotalSize() }}>
          {lines.getVirtualItems().map((item) => {
            const row = visible[item.index]!;
            return (
              <div className="diff-line" data-type={row.type} data-index={item.index} key={item.key} ref={lines.measureElement} style={{ transform: `translateY(${item.start}px)` }}>
                <span className="diff-no">{row.oldNo ?? ""}</span>
                <span className="diff-no">{row.newNo ?? ""}</span>
                <span className="diff-sign">{row.type === "add" ? "+" : row.type === "del" ? "-" : " "}</span>
                <span className="diff-code" dangerouslySetInnerHTML={{ __html: render(row) }} />
              </div>
            );
          })}
        </div>
      </div>
      {hidden > 0 && (
        <button className="diff-more" type="button" onClick={() => onExpand ? onExpand() : setDisclosed(true)}>{t(hidden === 1 ? "Show {count} more line" : "Show {count} more lines", { count: hidden })}
        </button>
      )}
      {patch.truncated && <div className="diff-more" data-static="true">{t("Diff truncated")}</div>}
    </div>
  );
}
