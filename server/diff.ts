import type { FilePatch, PatchHunk, PatchLine } from "../shared/protocol.ts";

const MAX_LINES = 4000;

/** Decode Git's C-quoted filenames, combining octal bytes before UTF-8 decoding. */
function unquotePath(value: string): string {
  const quoted = /^"((?:\\.|[^"\\])*)"$/.exec(value);
  if (!quoted) return value;
  const input = quoted[1]!;
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, "\\": 92, '"': 34 };
  const parts: Buffer[] = [];
  let from = 0;
  for (const match of input.matchAll(/\\([0-3][0-7]{2}|[abtnvfr\\"])/g)) {
    parts.push(Buffer.from(input.slice(from, match.index)));
    const escaped = match[1]!;
    parts.push(Buffer.from([escapes[escaped] ?? Number.parseInt(escaped, 8)]));
    from = match.index! + match[0].length;
  }
  parts.push(Buffer.from(input.slice(from)));
  return Buffer.concat(parts).toString("utf8");
}

/** Strip a unified header's tab-delimited timestamp, never whitespace in the path. */
function headerPath(value: string, prefix: "a" | "b"): string {
  const path = value.startsWith('"')
    ? /^"(?:\\.|[^"\\])*"/.exec(value)?.[0] ?? value
    : value.split("\t")[0] ?? "";
  const decoded = unquotePath(path);
  return decoded.startsWith(`${prefix}/`) ? decoded.slice(2) : decoded;
}

/** Read the destination in Git headers, including header-only binary/mode changes. */
function gitHeaderPath(value: string, fallback: string): string {
  const first = /^"(?:\\.|[^"\\])*" /.exec(value);
  if (first) return headerPath(value.slice(first[0].length), "b");
  const quotedDestination = value.indexOf(' "b/');
  if (quotedDestination >= 0) return headerPath(value.slice(quotedDestination + 1), "b");
  // Unquoted names may contain spaces and even " b/". Unchanged paths have
  // identical halves; prefer that split over treating part of a name as a prefix.
  const middle = (value.length - 1) / 2;
  if (Number.isInteger(middle) && value[middle] === " " && value.startsWith("a/") &&
      value.slice(middle + 1, middle + 3) === "b/" && value.slice(2, middle) === value.slice(middle + 3))
    return value.slice(middle + 3);
  const separator = value.indexOf(" b/");
  return separator < 0 ? fallback : value.slice(separator + 3);
}

/**
 * Parse Git-style or plain unified text diffs into bounded display patches.
 * Use declared hunk ranges to distinguish source content from file headers and
 * retain total change counts even when rendered lines are truncated.
 */
export function parseUnifiedDiff(text: string, fallbackPath = ""): FilePatch[] {
  const patches: FilePatch[] = [];
  let current: FilePatch | null = null;
  let hunk: PatchHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let oldRemaining = 0;
  let newRemaining = 0;

  const push = () => {
    if (current) patches.push(current);
    current = null;
    hunk = null;
  };

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      push();
      current = { path: gitHeaderPath(line.slice(11), fallbackPath), added: 0, removed: 0, hunks: [] };
      continue;
    }
    if (!hunk && line.startsWith("+++ ")) {
      const path = headerPath(line.slice(4), "b");
      if (!current) current = { path, added: 0, removed: 0, hunks: [] };
      else if (path && path !== "/dev/null") current.path = path;
      continue;
    }
    if (!hunk && line.startsWith("--- ")) {
      if (current?.hunks.length) push();
      if (!current) current = { path: fallbackPath, added: 0, removed: 0, hunks: [] };
      const path = headerPath(line.slice(4), "a");
      if (path && path !== "/dev/null") current.path = path;
      continue;
    }
    if (!hunk && current && (line.startsWith("rename to ") || line.startsWith("copy to "))) {
      current.path = unquotePath(line.slice(line.startsWith("rename to ") ? 10 : 8));
      continue;
    }
    if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (!match) continue;
      if (!current) current = { path: fallbackPath, added: 0, removed: 0, hunks: [] };
      oldNo = Number(match[1]);
      newNo = Number(match[3]);
      oldRemaining = Number(match[2] ?? 1);
      newRemaining = Number(match[4] ?? 1);
      hunk = { header: (match[5] ?? "").trim(), oldStart: oldNo, newStart: newNo, lines: [] };
      if (oldRemaining || newRemaining) current.hunks.push(hunk);
      else hunk = null;
      continue;
    }
    if (!current || !hunk) continue;
    if (line.startsWith("+")) {
      hunk.lines.push({ type: "add", text: line.slice(1), newNo });
      newNo += 1;
      current.added += 1;
      newRemaining -= 1;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ type: "del", text: line.slice(1), oldNo });
      oldNo += 1;
      current.removed += 1;
      oldRemaining -= 1;
    } else if (line.startsWith(" ")) {
      hunk.lines.push({ type: "ctx", text: line.slice(1), oldNo, newNo });
      oldNo += 1;
      newNo += 1;
      oldRemaining -= 1;
      newRemaining -= 1;
    }
    // Header-looking source lines belong to the hunk until its declared ranges end.
    if (oldRemaining <= 0 && newRemaining <= 0) hunk = null;
  }
  push();
  return patches.map(truncate);
}

function truncate(patch: FilePatch): FilePatch {
  let budget = MAX_LINES;
  const hunks: PatchHunk[] = [];
  for (const hunk of patch.hunks) {
    if (budget <= 0) return { ...patch, hunks, truncated: true };
    if (hunk.lines.length > budget) {
      hunks.push({ ...hunk, lines: hunk.lines.slice(0, budget) });
      return { ...patch, hunks, truncated: true };
    }
    hunks.push(hunk);
    budget -= hunk.lines.length;
  }
  return { ...patch, hunks };
}

function lcs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const table: Uint32Array = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[at(i, j)] =
        a[i] === b[j]
          ? (table[at(i + 1, j + 1)] ?? 0) + 1
          : Math.max(table[at(i + 1, j)] ?? 0, table[at(i, j + 1)] ?? 0);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if ((table[at(i + 1, j)] ?? 0) >= (table[at(i, j + 1)] ?? 0)) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

export function diffLines(before: string, after: string, path: string, startLine = 1): FilePatch {
  const a = before.length ? before.split("\n") : [];
  const b = after.length ? after.split("\n") : [];
  const lines: PatchLine[] = [];
  let added = 0;
  let removed = 0;

  const emit = (from: number, toA: number, fromB: number, toB: number) => {
    for (let i = from; i < toA; i += 1) {
      lines.push({ type: "del", text: a[i] ?? "", oldNo: startLine + i });
      removed += 1;
    }
    for (let j = fromB; j < toB; j += 1) {
      lines.push({ type: "add", text: b[j] ?? "", newNo: startLine + j });
      added += 1;
    }
  };

  if (a.length * b.length > 2_000_000) {
    emit(0, a.length, 0, b.length);
  } else {
    const pairs = lcs(a, b);
    let ai = 0;
    let bi = 0;
    for (const [pa, pb] of pairs) {
      emit(ai, pa, bi, pb);
      lines.push({ type: "ctx", text: a[pa] ?? "", oldNo: startLine + pa, newNo: startLine + pb });
      ai = pa + 1;
      bi = pb + 1;
    }
    emit(ai, a.length, bi, b.length);
  }

  const trimmed = trimContext(lines, 3);
  return truncate({
    path,
    added,
    removed,
    hunks: [{ header: "", oldStart: startLine, newStart: startLine, lines: trimmed }],
  });
}

function trimContext(lines: PatchLine[], radius: number): PatchLine[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.type === "ctx") return;
    for (let i = Math.max(0, index - radius); i <= Math.min(lines.length - 1, index + radius); i += 1) {
      keep[i] = true;
    }
  });
  const out: PatchLine[] = [];
  let gap = false;
  lines.forEach((line, index) => {
    if (keep[index]) {
      out.push(line);
      gap = false;
    } else if (!gap) {
      out.push({ type: "ctx", text: "…", oldNo: undefined, newNo: undefined });
      gap = true;
    }
  });
  return out;
}
