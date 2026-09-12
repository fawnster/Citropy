import { useEffect, useRef, useState } from "react";
import { renderMarkdown } from "./markdown.ts";
import { escapeHtml } from "./highlight.ts";
import { useApp } from "./store.ts";

const cache = new Map<string, string>();
const MAX_CACHE_SIZE = 4 * 1024 * 1024;
let cacheSize = 0;

function remember(key: string, html: string): void {
  const size = (key.length + html.length) * 2;
  if (size > MAX_CACHE_SIZE || cache.has(key)) return;
  while (cache.size >= 200 || cacheSize + size > MAX_CACHE_SIZE) {
    const oldest = cache.entries().next().value;
    if (!oldest) break;
    cache.delete(oldest[0]);
    cacheSize -= (oldest[0].length + oldest[1].length) * 2;
  }
  cache.set(key, html);
  cacheSize += size;
}

function fallback(text: string): string {
  return `<p>${escapeHtml(text).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br />")}</p>`;
}

export function useMarkdown(text: string, live: boolean): { html: string; ready: boolean } {
  const theme = useApp((state) => state.theme);
  const key = `${theme}:${text}`;
  const [rendered, setRendered] = useState(() => ({
    html: cache.get(key) ?? fallback(text),
    key: cache.has(key) ? key : null,
  }));
  const latest = useRef(key);

  useEffect(() => {
    latest.current = key;
    const cached = cache.get(key);
    if (cached !== undefined) {
      setRendered((current) => current.key === key ? current : { html: cached, key });
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    const run = async () => {
      const result = await renderMarkdown(text, theme, controller.signal).catch(() => fallback(text));
      if (cancelled || latest.current !== key) return;
      if (!live) remember(key, result);
      setRendered({ html: result, key });
    };
    if (!live) {
      void run();
      return () => {
        cancelled = true;
        controller.abort();
      };
    }
    const timer = setTimeout(run, 70);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [key, text, theme, live]);

  return { html: rendered.html, ready: rendered.key === key };
}
