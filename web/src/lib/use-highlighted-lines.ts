import { useEffect, useState } from "react";
import { highlightTokens } from "./highlight.ts";
import { useApp } from "./store.ts";

export function useHighlightedLines(code: string, lang?: string): string[] | null {
  const theme = useApp((state) => state.theme);
  const [result, setResult] = useState<{
    code: string;
    lang?: string;
    theme: string;
    lines: string[] | null;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    void highlightTokens(code, lang, theme, controller.signal).then((lines) => {
      if (!controller.signal.aborted) setResult({ code, lang, theme, lines });
    });
    return () => controller.abort();
  }, [code, lang, theme]);
  return result?.code === code && result.lang === lang && result.theme === theme ? result.lines : null;
}
