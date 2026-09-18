import { useMarkdown } from "../../lib/use-markdown.ts";
import { useMemo, useRef } from "react";
import { useApp } from "../../lib/store.ts";
import { useTextReveal } from "../../lib/use-text-reveal.ts";

interface Props {
  text: string;
  live: boolean;
  partId?: string;
  className?: string;
}

export function Prose({ partId, text, live, className }: Props) {
  const streaming = useApp((state) => state.textStreaming);
  const waiting = live && !streaming;
  const { html, ready } = useMarkdown(waiting ? "" : text, live && streaming);
  const root = useRef<HTMLDivElement>(null);
  const revealing = useTextReveal(root, partId, html, live, ready);
  const markup = useMemo(() => ({ __html: html }), [html]);
  if (!text || waiting || (!streaming && !ready)) return null;
  return (
    <div
      className={className ? `prose ${className}` : "prose"}
      ref={root}
      data-part-id={partId}
      data-live={(streaming && live) || revealing || undefined}
      aria-busy={revealing || undefined}
      onLoadCapture={event => {
        if (event.target instanceof HTMLImageElement && event.target.classList.contains("link-favicon")) event.target.parentElement?.setAttribute("data-loaded", "");
      }}
      onErrorCapture={event => {
        if (event.target instanceof HTMLImageElement && event.target.classList.contains("link-favicon")) {
          event.target.hidden = true;
          event.target.parentElement?.removeAttribute("data-loaded");
        }
      }}
      dangerouslySetInnerHTML={markup}
    />
  );
}
