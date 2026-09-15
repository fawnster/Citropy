import type { AppState } from "./store.ts";
import { buildRows, type Row } from "./group.ts";

export interface TimelineRow {
  key: string;
  messageId: string;
  row?: Row | { kind: "activity"; id: string; ids: string[]; open: boolean };
  first: boolean;
  last: boolean;
  separator?: boolean;
}

export function timelineRows(state: AppState, threadId: string): TimelineRow[] {
  const order = state.order[threadId] ?? [];
  const thread = state.threads[threadId];
  return order.flatMap<TimelineRow>((messageId) => {
    const message = state.messages[messageId];
    if (!message) return [];
    const rows =
      message.role === "user"
        ? []
        : buildRows(message.partIds.map((id) => state.parts[id]));
    if (!rows.length)
      return message.role === "user"
        ? [{ key: messageId, messageId, first: true, last: true }]
        : [];
    let visible: NonNullable<TimelineRow["row"]>[] = rows;
    let answer: Row | undefined;
    const hasWork = rows.some((row) => row.kind === "group" ||
      ["reasoning", "todo"].includes(state.parts[row.id]?.kind ?? ""));
    if (hasWork) {
      const finalIndex = rows.findLastIndex((row) => row.kind === "part" && state.parts[row.id]?.kind === "text");
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
        return part?.kind !== "notice" || part.level === "info";
      }));
      const ids = rows.filter(row => work.has(row)).flatMap(row => row.kind === "group" ? row.ids : [row.id]);
      const id = message.partIds[0]!;
      const latest = order.at(-1) === messageId;
      const active = latest && Boolean(thread?.running || ["thinking", "working", "queued", "awaiting"].includes(thread?.status ?? ""));
      const interrupted = latest && (thread?.status === "stopped" || thread?.status === "error");
      const unfinished = message.partIds.some(id => {
        const part = state.parts[id];
        return part?.kind === "tool" ? part.status === "running" :
          (part?.kind === "text" || part?.kind === "reasoning") && part.complete === false;
      });
      const open = state.disclosures[id]?.activity ?? (active || interrupted || unfinished || finalIndex === -1);
      visible = [{ kind: "activity", id, ids, open }, ...rows.filter(row => open || !work.has(row))];
    }
    return visible.map((row, index) => ({
      key: row.kind === "activity" ? `activity-${messageId}` : row.kind === "group" ? `group-${row.ids[0]}` : row.id,
      messageId,
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
        (row.id !== next.id || row.open !== next.open)) return false;
      return row.ids.length === next.ids.length && row.ids.every((id, i) => id === next.ids[i]);
    })
  );
}
