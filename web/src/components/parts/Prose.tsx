import { useMarkdown } from "../../lib/use-markdown.ts";
import { useMemo, useRef } from "react";
import { useApp } from "../../lib/store.ts";
import { useTextReveal } from "../../lib/use-text-reveal.ts";

interface Props {
  text: string;
  live: boolean;
  partId?: string;
}

export function Prose({ partId, text, live }: Props) {
  const streaming = useApp((state) => state.textStreaming);
  const waiting = live && !streaming;
  const { html, ready } = useMarkdown(waiting ? "" : text, live && streaming);
  const root = useRef<HTMLDivElement>(null);
  const revealing = useTextReveal(root, partId, html, live, ready);
  const markup = useMemo(() => ({ __html: html }), [html]);
  if (!text || waiting || (!streaming && !ready)) return null;
  return (
    <div
      className="prose"
      ref={root}
      data-part-id={partId}
      data-live={(streaming && live) || revealing || undefined}
      aria-busy={revealing || undefined}
      dangerouslySetInnerHTML={markup}
    />
  );
}
