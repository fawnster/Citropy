export interface ContextSource {
  path: string;
  kind: "file" | "folder";
  characters: number;
  startLine?: number;
  endLine?: number;
  truncated?: boolean;
}

export function contextReference(path: string): string { return `@[${path.replaceAll("\\", "\\\\").replaceAll("]", "\\]")}]`; }

export function contextReferences(text: string): Array<{ path: string; startLine?: number; endLine?: number }> {
  return [...text.matchAll(/@\[((?:\\.|[^\]\\])+)\](?:#L(\d+)(?:-L?(\d+))?)?/g)].map(match => ({ path: match[1]!.replace(/\\(.)/g, "$1"), ...(match[2] ? { startLine: Number(match[2]), endLine: Number(match[3] ?? match[2]) } : {}) }));
}
