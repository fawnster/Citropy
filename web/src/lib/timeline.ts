import type { AppState } from "./store.ts";
import { buildRows, type Row } from "./group.ts";

export interface TimelineRow {
  key: string;
  messageId: string;
  row?: Row | { kind: "activity"; id: string; ids: string[]; messageIds: string[]; open: boolean; active: boolean; previewId?: string } | { kind: "images"; id: string; ids: string[] };
  first: boolean;
  last: boolean;
  separator?: boolean;
}

export function timelineRows(state: AppState, threadId: string): TimelineRow[] {
  const order = state.order[threadId] ?? [];
  const thread = state.threads[threadId];
  const running = Boolean(thread?.running || thread?.compacting || ["thinking", "working", "queued", "awaiting"].includes(thread?.status ?? ""));
  const startedAt = thread?.runStartedAt;
  const lastAssistantId = order.findLast(id => state.messages[id]?.role === "assistant");
  const replies: string[][] = [];
  let unfinishedReply = false;
  for (const messageId of order) {
    const message = state.messages[messageId];
    const previous = replies.at(-1);
    if (message?.role === "assistant" && previous && unfinishedReply) previous.push(messageId);
    else replies.push([messageId]);
    const last = message?.partIds.map(id => state.parts[id]).findLast(part => part && part.kind !== "notice" &&
      (!(part.kind === "text" || part.kind === "reasoning") || part.text.trim()));
    unfinishedReply = message?.role === "assistant" && (last ? last.kind !== "text" || last.complete === false : unfinishedReply);
  }
  return replies.flatMap<TimelineRow>((messageIds) => {
    const messageId = messageIds[0]!;
    const message = state.messages[messageId];
    if (!message) return [];
    const owners = new Map(messageIds.flatMap(id => state.messages[id]!.partIds.map(partId => [partId, id] as const)));
    const partIds = [...owners.keys()];
    const rows =
      message.role === "user"
        ? []
        : buildRows(partIds.map((id) => state.parts[id]));
    if (!rows.length)
      return message.role === "user"
        ? [{ key: messageId, messageId, first: true, last: true }]
        : [];
    let visible: NonNullable<TimelineRow["row"]>[] = rows;
    let answer: Row | undefined;
    const hasWork = rows.some((row) => row.kind !== "part" ||
      ["todo", "question"].includes(state.parts[row.id]?.kind ?? ""));
    if (hasWork) {
      const continuing = running && startedAt !== undefined && messageIds.some(id => state.messages[id]!.ts >= startedAt);
      const latest = order.at(-1) === messageIds.at(-1) || continuing && messageIds.includes(lastAssistantId ?? "");
      const active = latest && running;
      const plan = active || continuing ? rows.findLast(row => row.kind === "part" && state.parts[row.id]?.kind === "todo") : undefined;
      const lastContent = rows.findLastIndex(row => row.kind !== "part" || state.parts[row.id]?.kind !== "notice");
      const finalRow = rows[lastContent];
      const lastText = rows.findLastIndex(row => row.kind === "part" && state.parts[row.id]?.kind === "text");
      const followingWork = rows.slice(lastText + 1).some(row => row.kind === "group" || row.kind === "part" && ["todo", "question"].includes(state.parts[row.id]?.kind ?? ""));
      const endsWithText = finalRow?.kind === "part" && state.parts[finalRow.id]?.kind === "text";
      const finalIndex = followingWork || (active || continuing) && !endsWithText ? -1 : lastText;
      let finalStart = finalIndex;
      while (finalStart > 0) {
        const previous = rows[finalStart - 1]!;
        const part = previous.kind === "part" ? state.parts[previous.id] : undefined;
        if (part?.kind !== "text" && part?.kind !== "notice") break;
        finalStart -= 1;
      }
      answer = rows[finalStart];
      const work = new Set(rows.filter((row, index) => {
        if (index >= finalStart && index <= finalIndex) return false;
        const part = row.kind === "part" ? state.parts[row.id] : undefined;
        if (row === plan || part?.kind === "question" && part.status === "pending") return false;
        if (part?.kind === "images") return false;
        return part?.kind !== "notice" || part.level === "info";
      }));
      const ids = rows.filter(row => work.has(row)).flatMap(row => row.kind === "part" ? [row.id] : row.ids);
      const id = partIds[0]!;
      const open = state.disclosures[id]?.activity ?? false;
      const previewId = finalIndex === -1 ? ids.findLast(id => state.parts[id]?.kind === "text") : undefined;
      visible = ids.length ? [{ kind: "activity", id, ids, messageIds, open, active, previewId }, ...rows.filter(row => open || !work.has(row))] : rows;
    }
    const imageIds = partIds.filter((id) => {
      const part = state.parts[id];
      return part?.kind === "tool" && Boolean(part.images?.length || part.imageFiles?.length);
    });
    if (imageIds.length) visible = [...visible, { kind: "images", id: `images-${messageId}`, ids: imageIds }];
    return visible.map((row, index) => ({
      key: row.kind === "activity" ? `activity-${messageId}` : row.kind === "part" ? row.id : `${row.kind}-${row.ids[0]}`,
      messageId: row.kind === "activity" ? messageId : owners.get(row.kind === "part" ? row.id : row.ids[0]!)!,
      row,
      first: index === 0,
      last: index === visible.length - 1,
      separator: row === answer || undefined,
    }));
  });
}

export function sameTimelineRows(a: TimelineRow[], b: TimelineRow[]): boolean {
  return (
    a.length === b.length &&
    a.every((item, index) => {
      const other = b[index]!;
      if (item.key !== other.key || item.messageId !== other.messageId ||
        item.first !== other.first || item.last !== other.last || item.separator !== other.separator || item.row?.kind !== other.row?.kind) return false;
      const row = item.row;
      const next = other.row;
      if (!row || row.kind === "part") return true;
      if (!next || next.kind === "part") return false;
      if (row.kind === "activity" && next.kind === "activity" &&
        (row.id !== next.id || row.open !== next.open || row.active !== next.active || row.previewId !== next.previewId || row.messageIds.length !== next.messageIds.length ||
          row.messageIds.some((id, i) => id !== next.messageIds[i]))) return false;
      return row.ids.length === next.ids.length && row.ids.every((id, i) => id === next.ids[i]);
    })
  );
}
