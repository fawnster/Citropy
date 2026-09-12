import type { AppState } from "./store.ts";
import { buildRows, type Row } from "./group.ts";

export interface TimelineRow {
  key: string;
  messageId: string;
  row?: Row;
  first: boolean;
  last: boolean;
}

export function timelineRows(state: AppState, threadId: string): TimelineRow[] {
  return (state.order[threadId] ?? []).flatMap<TimelineRow>((messageId) => {
    const message = state.messages[messageId];
    if (!message) return [];
    const rows =
      message.role === "user"
        ? []
        : buildRows(message.partIds.map((id) => state.parts[id]));
    if (!rows.length)
      return [{ key: messageId, messageId, first: true, last: true }];
    return rows.map((row, index) => ({
      key: row.kind === "group" ? `group-${row.ids[0]}` : row.id,
      messageId,
      row,
      first: index === 0,
      last: index === rows.length - 1,
    }));
  });
}

export function sameTimelineRows(a: TimelineRow[], b: TimelineRow[]): boolean {
  return (
    a.length === b.length &&
    a.every((item, index) => {
      const other = b[index]!;
      const group = other.row?.kind === "group" ? other.row.ids : [];
      return (
        item.key === other.key &&
        item.messageId === other.messageId &&
        item.first === other.first &&
        item.last === other.last &&
        (item.row?.kind !== "group" ||
          (other.row?.kind === "group" &&
            item.row.ids.length === other.row.ids.length &&
            item.row.ids.every((id, i) => id === group[i])))
      );
    })
  );
}
