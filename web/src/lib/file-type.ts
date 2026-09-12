const extensions = {
  ts: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  tsx: "react", jsx: "react", vue: "vue", svelte: "svelte",
  py: "python", pyi: "python", pyw: "python", ipynb: "python",
  rs: "rust", go: "go", rb: "ruby", java: "java", kt: "kotlin", kts: "kotlin",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  cs: "csharp", php: "php", swift: "swift", lua: "lua", luau: "lua",
  html: "html", htm: "html", xml: "html", css: "css", scss: "sass", sass: "sass", less: "css",
  json: "json", jsonc: "json", json5: "json", yaml: "config", yml: "config", toml: "config", ini: "config", conf: "config", config: "config", env: "config",
  md: "markdown", mdx: "markdown", markdown: "markdown", txt: "text", log: "text", rst: "text",
  pdf: "pdf", doc: "document", docx: "document", odt: "document", rtf: "document",
  xls: "spreadsheet", xlsx: "spreadsheet", ods: "spreadsheet", csv: "spreadsheet", tsv: "spreadsheet",
  ppt: "presentation", pptx: "presentation", odp: "presentation",
  svg: "vector", ai: "vector", eps: "vector",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", avif: "image", ico: "image", bmp: "image", tif: "image", tiff: "image", heic: "image", psd: "image",
  mp3: "audio", wav: "audio", flac: "audio", aac: "audio", m4a: "audio", ogg: "audio", opus: "audio",
  mp4: "video", webm: "video", mov: "video", mkv: "video", avi: "video", m4v: "video",
  zip: "archive", tar: "archive", gz: "archive", tgz: "archive", bz2: "archive", xz: "archive", "7z": "archive", rar: "archive", zst: "archive",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell", ps1: "shell", bat: "shell", cmd: "shell",
  sql: "database", sqlite: "database", sqlite3: "database", db: "database",
  woff: "font", woff2: "font", ttf: "font", otf: "font",
  lock: "lock", pem: "certificate", crt: "certificate", cer: "certificate", key: "certificate",
  exe: "binary", dll: "binary", so: "binary", dylib: "binary", wasm: "binary", bin: "binary",
} as const;

export type FileType = typeof extensions[keyof typeof extensions] | "git" | "docker" | "package" | "file";

export function fileTypeFor(path: string, mime?: string): FileType {
  const name = path.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  if ([".gitignore", ".gitattributes", ".gitmodules", ".gitkeep"].includes(name)) return "git";
  if (/^(dockerfile|containerfile)(\.|$)/.test(name) || name === ".dockerignore" || /^(docker-)?compose\.ya?ml$/.test(name)) return "docker";
  if (/^(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|cargo\.toml|go\.mod|pyproject\.toml|composer\.json|gemfile)$/.test(name)) return "package";
  if (/^\.env(\.|$)/.test(name) || /^\.(npmrc|nvmrc|yarnrc|editorconfig|prettierrc|eslintrc)(\.|$)/.test(name)) return "config";
  if (/^(readme|changelog|contributing)(\.|$)/.test(name)) return "markdown";
  if (/^(license|licence|copying)(\.|$)/.test(name)) return "text";
  if (/^(makefile|justfile|\.bashrc|\.zshrc|\.profile)$/.test(name)) return "shell";
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  if (Object.hasOwn(extensions, extension)) return extensions[extension as keyof typeof extensions];
  const type = mime?.split(";")[0]?.trim().toLowerCase();
  if (type === "image/svg+xml") return "vector";
  if (type?.startsWith("image/")) return "image";
  if (type?.startsWith("audio/")) return "audio";
  if (type?.startsWith("video/")) return "video";
  if (type === "application/pdf") return "pdf";
  if (type === "application/json" || type?.endsWith("+json")) return "json";
  if (type === "text/markdown") return "markdown";
  if (type?.startsWith("text/")) return "text";
  return "file";
}
