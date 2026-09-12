import { currentLocale, translate } from "./i18n.ts";
import type {
  ModelOption,
  ProviderId,
  ProviderInfo,
} from "../../../shared/protocol.ts";
import { selectedModel } from "../../../shared/model-options.ts";

export const providerLabels: Record<ProviderId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

export function modelLabel(models: ModelOption[], modelId?: string): string {
  return (
    selectedModel(models, modelId)?.label ??
    (modelId && modelId !== "default" ? modelId : translate("Model unavailable"))
  );
}

export function modelSource(
  provider: ProviderInfo | undefined,
  model?: ModelOption,
): string {
  if (!provider) return translate("Provider unavailable");
  if (provider.id !== "opencode") return provider.label;
  const source = model?.hint ?? model?.id.split("/")[0];
  if (!source) return provider.label;
  const names: Record<string, string> = {
    opencode: "OpenCode Zen",
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google",
    openrouter: "OpenRouter",
    "github-copilot": "GitHub Copilot",
    "amazon-bedrock": "Amazon Bedrock",
    azure: "Azure",
  };
  return `${provider.label} · ${names[source] ?? source}`;
}

export function effortLabel(effort: string): string {
  return translate(effort === "xhigh"
    ? "Extra high"
    : effort.charAt(0).toUpperCase() + effort.slice(1));
}

export function tokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 100_000)
    return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

export function cost(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

export function duration(ms: number): string {
  if (ms < 950) return `${Math.max(ms, 1).toFixed(0)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

export function ago(ts: number, now = Date.now()): string {
  const delta = Math.max(now - ts, 0);
  if (delta < 45_000) return translate("just now");
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return translate("{count}m ago", { count: minutes });
  const hours = Math.round(delta / 3_600_000);
  if (hours < 24) return translate("{count}h ago", { count: hours });
  const days = Math.round(delta / 86_400_000);
  if (days < 7) return translate("{count}d ago", { count: days });
  return new Date(ts).toLocaleDateString(currentLocale(), {
    month: "short",
    day: "numeric",
  });
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString(currentLocale(), {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function shortPath(path: string, home: string): string {
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  py: "python",
  rs: "rust",
  go: "go",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  css: "css",
  scss: "scss",
  html: "html",
  vue: "vue",
  svelte: "svelte",
  md: "markdown",
  mdx: "markdown",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
  lua: "lua",
  luau: "lua",
  dockerfile: "docker",
  diff: "diff",
  patch: "diff",
};

export function langFor(path: string): string {
  const name = path.split("/").pop() ?? path;
  if (/^dockerfile$/i.test(name)) return "docker";
  if (/^makefile$/i.test(name)) return "makefile";
  const ext = name.includes(".")
    ? (name.split(".").pop() ?? "").toLowerCase()
    : "";
  return EXT_LANG[ext] ?? "text";
}
