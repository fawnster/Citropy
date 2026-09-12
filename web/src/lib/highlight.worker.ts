import { highlight, highlightTokens } from "./highlight-core.ts";
import type { HighlightRequest } from "./highlight.ts";

const queue = new Map<number, HighlightRequest>();
const cache = new Map<string, { result: string | string[] | null; bytes: number }>();
let bytes = 0;
let running = false;

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  while (queue.size) {
    const request = queue.values().next().value!;
    queue.delete(request.id);
    const key = `${request.kind}:${request.theme}:${request.lang}:${request.code}`;
    let entry = cache.get(key);
    if (entry) {
      cache.delete(key);
      cache.set(key, entry);
    } else {
      const result = request.kind === "html"
        ? await highlight(request.code, request.lang, request.theme)
        : await highlightTokens(request.code, request.lang, request.theme);
      const size = 2 * (key.length + (typeof result === "string" ? result.length : result?.reduce((total, line) => total + line.length, 0) ?? 0));
      entry = { result, bytes: size };
      if (size <= 2 * 1024 * 1024) {
        while (cache.size >= 128 || bytes + size > 2 * 1024 * 1024) {
          const oldest = cache.entries().next().value;
          if (!oldest) break;
          bytes -= oldest[1].bytes;
          cache.delete(oldest[0]);
        }
        cache.set(key, entry);
        bytes += size;
      }
    }
    self.postMessage({ id: request.id, result: entry.result });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  running = false;
}

self.onmessage = (event: MessageEvent<HighlightRequest | { cancel: number }>) => {
  if ("cancel" in event.data) queue.delete(event.data.cancel);
  else {
    queue.set(event.data.id, event.data);
    void drain();
  }
};
