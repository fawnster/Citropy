import { Marked, type Tokens } from "marked";
import { escapeHtml, highlight } from "./highlight.ts";

interface CodeToken extends Tokens.Code {
  rendered?: string;
}

function createParser(theme: "dark" | "light", signal?: AbortSignal) {
  const marked = new Marked({
    gfm: true,
    breaks: false,
    async: true,
  });

  marked.use({
    async: true,
    walkTokens: async (token) => {
      if (token.type !== "code" || signal?.aborted) return;
      const code = token as CodeToken;
      code.rendered = await highlight(code.text, code.lang, theme, signal);
    },
    renderer: {
      code(token) {
        const code = token as CodeToken;
        const label = (code.lang ?? "").split(/\s+/)[0] ?? "";
        const body = code.rendered ?? `<pre class="raw"><code>${escapeHtml(code.text)}</code></pre>`;
        return `<figure class="code-block" data-lang="${escapeHtml(label)}"><figcaption>${escapeHtml(label || "text")}</figcaption>${body}</figure>`;
      },
      html(token) {
        return escapeHtml((token as Tokens.HTML).raw);
      },
      link(token) {
        const link = token as Tokens.Link;
        const href = escapeHtml(link.href ?? "");
        const safe = /^(https?:|mailto:)/i.test(href) ? href : "#";
        let icon = "";
        try {
          const url = new URL(link.href);
          if (["http:", "https:"].includes(url.protocol)) {
            const favicon = escapeHtml(`${url.origin}/favicon.ico`);
            icon = `<span class="link-site-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18"/></svg><img class="link-favicon" src="${favicon}" width="14" height="14" alt="" decoding="async" referrerpolicy="no-referrer"/></span>`;
          }
        } catch {}
        return `<a href="${safe}" target="_blank" rel="noreferrer noopener">${icon}${this.parser.parseInline(link.tokens)}</a>`;
      },
    },
  });

  return marked;
}

export async function renderMarkdown(text: string, mode: "dark" | "light", signal?: AbortSignal): Promise<string> {
  if (/^\s*\d+[.)]\s*$/.test(text)) return `<p>${escapeHtml(text.trim())}</p>`;
  return (await createParser(mode, signal).parse(text)) as string;
}
