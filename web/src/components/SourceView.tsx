import { useI18n } from "../lib/i18n.ts";
import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useHighlightedLines } from "../lib/use-highlighted-lines.ts";
import { escapeHtml } from "../lib/highlight.ts";
import { langFor } from "../lib/format.ts";
import { scaled } from "../lib/store.ts";

export function SourceView({ text, path }: { text: string; path: string }) {
  const t = useI18n();
  const viewport = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => text.split("\n"), [text]);
  const highlighted = useHighlightedLines(text, langFor(path));
  const list = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: lines.length,
    getScrollElement: () => viewport.current,
    estimateSize: () => scaled(22),
    overscan: 8,
    measureElement: (element) => element.offsetHeight,
  });
  return (
    <div className="preview-body source-view scroll" ref={viewport} role="region" aria-label={t("Source of {path}", { path })} tabIndex={0}>
      <div className="source-lines" style={{ height: list.getTotalSize() }}>
        {list.getVirtualItems().map((item) => (
          <div className="source-line" data-index={item.index} key={item.key} ref={list.measureElement} style={{ transform: `translateY(${item.start}px)` }}>
            <span className="source-line-number" aria-hidden="true">{item.index + 1}</span>
            <code dangerouslySetInnerHTML={{ __html: highlighted?.[item.index] ?? escapeHtml(lines[item.index]!) }} />
          </div>
        ))}
      </div>
    </div>
  );
}
