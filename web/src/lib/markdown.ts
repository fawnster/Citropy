import { Marked, type Tokens } from "marked";
import { escapeHtml, highlight } from "./highlight.ts";

interface CodeToken extends Tokens.Code {
  rendered?: string;
}

function createParser(theme: "dark" | "light") {
  const marked = new Marked({
    gfm: true,
    breaks: false,
    async: true,
  });

  marked.use({
    async: true,
    walkTokens: async (token) => {
      if (token.type !== "code") return;
      const code = token as CodeToken;
      code.rendered = await highlight(code.text, code.lang, theme);
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
        return `<a href="${safe}" target="_blank" rel="noreferrer noopener">${this.parser.parseInline(link.tokens)}</a>`;
      },
    },
  });

  return marked;
}

const parsers = { dark: createParser("dark"), light: createParser("light") };

export async function renderMarkdown(text: string, mode: "dark" | "light"): Promise<string> {
  return (await parsers[mode].parse(text)) as string;
}
