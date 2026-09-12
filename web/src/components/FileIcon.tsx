import {
  Atom, Braces, CodeXml, Container, Database, File, FileArchive, FileAudio2,
  FileCode2, FileCog, FileImage, FileKey2, FileLock2, FileSpreadsheet,
  FileText, FileType2, FileVideo2, GitBranch, Hash, Package, PenTool,
  Presentation, Terminal, type LucideIcon,
} from "lucide-react";
import { fileTypeFor, type FileType } from "../lib/file-type.ts";

const icons: Record<FileType, { icon?: LucideIcon; mark?: string; tone: string }> = {
  typescript: { mark: "TS", tone: "blue" },
  javascript: { mark: "JS", tone: "gold" },
  react: { icon: Atom, tone: "cyan" },
  python: { mark: "PY", tone: "blue" },
  rust: { mark: "RS", tone: "orange" },
  go: { mark: "GO", tone: "cyan" },
  ruby: { mark: "RB", tone: "red" },
  java: { mark: "J", tone: "orange" },
  kotlin: { mark: "KT", tone: "purple" },
  c: { mark: "C", tone: "blue" },
  cpp: { mark: "C++", tone: "blue" },
  csharp: { mark: "C#", tone: "purple" },
  php: { mark: "PHP", tone: "purple" },
  swift: { mark: "SW", tone: "orange" },
  lua: { mark: "LUA", tone: "blue" },
  vue: { mark: "V", tone: "green" },
  svelte: { mark: "S", tone: "orange" },
  html: { icon: CodeXml, tone: "orange" },
  css: { icon: Hash, tone: "blue" },
  sass: { icon: Hash, tone: "pink" },
  json: { icon: Braces, tone: "gold" },
  config: { icon: FileCog, tone: "purple" },
  markdown: { mark: "MD", tone: "blue" },
  text: { icon: FileText, tone: "neutral" },
  document: { icon: FileText, tone: "blue" },
  pdf: { mark: "PDF", tone: "red" },
  spreadsheet: { icon: FileSpreadsheet, tone: "green" },
  presentation: { icon: Presentation, tone: "orange" },
  vector: { icon: PenTool, tone: "pink" },
  image: { icon: FileImage, tone: "purple" },
  audio: { icon: FileAudio2, tone: "pink" },
  video: { icon: FileVideo2, tone: "purple" },
  archive: { icon: FileArchive, tone: "gold" },
  shell: { icon: Terminal, tone: "green" },
  database: { icon: Database, tone: "cyan" },
  font: { icon: FileType2, tone: "pink" },
  lock: { icon: FileLock2, tone: "gold" },
  certificate: { icon: FileKey2, tone: "green" },
  binary: { icon: FileCode2, tone: "neutral" },
  git: { icon: GitBranch, tone: "orange" },
  docker: { icon: Container, tone: "blue" },
  package: { icon: Package, tone: "red" },
  file: { icon: File, tone: "neutral" },
};

export function FileIcon({ path, mime, size = 16, className = "" }: { path: string; mime?: string; size?: number; className?: string }) {
  const type = fileTypeFor(path, mime);
  const { icon: Icon, mark, tone } = icons[type];
  const props = { className: `file-type-icon ${className}`, "data-file-type": type, "data-tone": tone, "aria-hidden": true as const, focusable: false as const };
  return Icon ? <Icon {...props} size={size} strokeWidth={1.7} /> : (
    <svg {...props} width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <rect x="1.5" y="1.5" width="21" height="21" rx="3" fillOpacity="0.14" />
      <text x="12" y="16" textAnchor="middle" fontFamily="var(--font-ui)" fontWeight="750" fontSize={mark!.length > 2 ? 8.5 : 11}>{mark}</text>
    </svg>
  );
}
