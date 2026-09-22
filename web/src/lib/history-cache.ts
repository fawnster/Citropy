import type { AppState } from "./app-state.ts";
import type { Message, Part, ServerEvent } from "../../../shared/protocol.ts";

export function replaceHistory(
  state: AppState,
  threadId: string,
  messages: Message[],
): void {
  removeMessages(state, threadId);
  const ids: string[] = [];
  for (const message of messages) {
    const partIds: string[] = [];
    for (const part of message.parts) {
      state.parts[part.id] = part;
      partIds.push(part.id);
    }
    state.messages[message.id] = {
      id: message.id,
      role: message.role,
      ts: message.ts,
      model: message.model,
      provider: message.provider,
      attachments: message.attachments,
      partIds,
    };
    ids.push(message.id);
  }
  state.order[threadId] = ids;
  state.loaded[threadId] = true;
  state.historyBytes[threadId] = contentBytes(messages);
}

function contentBytes(value: unknown): number {
  if (typeof value === "string") return value.length * 2;
  if (!value || typeof value !== "object") return 8;
  if (Array.isArray(value))
    return value.reduce((size, item) => size + contentBytes(item), 24);
  return Object.entries(value).reduce(
    (size, [key, item]) => size + key.length * 2 + contentBytes(item),
    32,
  );
}

export function removeMessages(state: AppState, threadId: string): void {
  for (const id of state.order[threadId] ?? []) {
    for (const partId of state.messages[id]?.partIds ?? []) {
      delete state.parts[partId];
      delete state.reveals[partId];
      delete state.disclosures[partId];
    }
    delete state.messages[id];
  }
  delete state.order[threadId];
  delete state.loaded[threadId];
  delete state.historyBytes[threadId];
}

export type HistoryCollection = "messages" | "parts" | "order" | "loaded" | "reveals" | "historyBytes" | "disclosures";
const allHistory: HistoryCollection[] = [
  "messages", "parts", "order", "loaded", "reveals", "historyBytes", "disclosures",
];
export const historyChanges: Partial<Record<ServerEvent["t"], HistoryCollection[]>> = {
  "thread.remove": allHistory,
  "thread.messages": allHistory,
  "message.add": ["messages", "parts", "order", "reveals", "historyBytes"],
  "part.add": ["messages", "parts", "reveals", "historyBytes"],
  "part.append": ["parts", "historyBytes"],
  "part.patch": ["parts", "historyBytes"],
};

function totalHistoryBytes(state: AppState): number {
  let total = 0;
  for (const bytes of Object.values(state.historyBytes)) total += bytes;
  return total;
}

export function trimHistories(state: AppState, previous?: AppState): void {
  const ids = Object.keys(state.loaded);
  const bytesTotal = totalHistoryBytes(state);
  if (ids.length <= 5 && bytesTotal <= 16 * 1024 * 1024) return;
  if (
    previous &&
    bytesTotal === totalHistoryBytes(previous) &&
    ids.length === Object.keys(previous.loaded).length
  )
    return;
  let bytes = bytesTotal;
  let count = ids.length;
  const evict: string[] = [];
  for (const id of ids) {
    if (count <= 5 && bytes <= 16 * 1024 * 1024) break;
    if (id === state.activeThreadId) continue;
    evict.push(id);
    bytes -= state.historyBytes[id] ?? 0;
    count -= 1;
  }
  if (!evict.length) return;
  for (const key of allHistory) Object.assign(state, { [key]: { ...state[key] } });
  for (const id of evict) removeMessages(state, id);
}

export function unloadedDelta(state: AppState, event: ServerEvent): boolean {
  return (
    (event.t === "message.add" || event.t === "part.add" ||
      event.t === "part.append" || event.t === "part.patch") &&
    !state.loaded[event.threadId]
  );
}

export function applyMessageEvent(
  state: AppState,
  event: Extract<
    ServerEvent,
    { t: "message.add" } | { t: "part.add" } | { t: "part.append" } | { t: "part.patch" }
  >,
): void {
  switch (event.t) {
    case "message.add": {
      state.historyBytes[event.threadId] = (state.historyBytes[event.threadId] ?? 0) + contentBytes(event.message);
      const partIds: string[] = [];
      for (const part of event.message.parts) {
        state.parts[part.id] = part;
        if (event.message.role === "assistant" && part.kind === "text")
          state.reveals[part.id] = true;
        partIds.push(part.id);
      }
      state.messages[event.message.id] = {
        id: event.message.id,
        role: event.message.role,
        ts: event.message.ts,
        model: event.message.model,
        provider: event.message.provider,
        attachments: event.message.attachments,
        partIds,
      };
      state.order[event.threadId] = [
        ...(state.order[event.threadId] ?? []),
        event.message.id,
      ];
      return;
    }
    case "part.add": {
      const shell = state.messages[event.messageId];
      if (!shell) return;
      state.historyBytes[event.threadId] = (state.historyBytes[event.threadId] ?? 0) + contentBytes(event.part);
      state.parts[event.part.id] = event.part;
      if (shell.role === "assistant" && event.part.kind === "text")
        state.reveals[event.part.id] = true;
      state.messages[event.messageId] = {
        ...shell,
        partIds: [...shell.partIds, event.part.id],
      };
      return;
    }
    case "part.append": {
      const part = state.parts[event.partId];
      if (!part || (part.kind !== "text" && part.kind !== "reasoning")) return;
      state.historyBytes[event.threadId] = (state.historyBytes[event.threadId] ?? 0) + event.text.length * 2;
      state.parts[event.partId] = { ...part, text: part.text + event.text };
      return;
    }
    case "part.patch": {
      const part = state.parts[event.partId];
      if (!part) return;
      const updated = { ...part, ...event.patch } as Part;
      state.historyBytes[event.threadId] = (state.historyBytes[event.threadId] ?? 0) + contentBytes(updated) - contentBytes(part);
      state.parts[event.partId] = updated;
      return;
    }
  }
}
