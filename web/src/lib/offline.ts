import { reportError } from "./api.ts";
import { awaitResponse } from "./requests.ts";
import { requestId, send } from "./socket.ts";
import { useApp } from "./store.ts";
import type { Attachment, QueuedMessage } from "../../../shared/protocol.ts";

let flushing = false;

function save(offline: Record<string, QueuedMessage[]>): void {
  useApp.setState({ offline });
  localStorage.setItem("citropy.offline", JSON.stringify(offline));
}

export function holdMessage(
  threadId: string,
  text: string,
  attachments: Attachment[],
): void {
  const { offline } = useApp.getState();
  const item = { id: crypto.randomUUID(), text, attachments, createdAt: Date.now() };
  save({ ...offline, [threadId]: [...(offline[threadId] ?? []), item] });
}

export function takeHeld(threadId: string, id: string): QueuedMessage {
  const offline = { ...useApp.getState().offline };
  const item = offline[threadId]?.find((entry) => entry.id === id);
  if (!item) throw new Error("This message was already sent or removed.");
  const rest = offline[threadId]!.filter((entry) => entry !== item);
  if (rest.length) offline[threadId] = rest;
  else delete offline[threadId];
  save(offline);
  return item;
}

export async function flushHeld(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    for (const [threadId, items] of Object.entries(useApp.getState().offline)) {
      for (const item of items) {
        if (!useApp.getState().connected) return;
        if (!useApp.getState().threads[threadId]) {
          takeHeld(threadId, item.id);
          continue;
        }
        const id = requestId();
        const accepted = awaitResponse(id);
        send({ t: "thread.send", threadId, text: item.text, attachments: item.attachments, requestId: id });
        try {
          await accepted;
        } catch (error) {
          reportError(error);
          break;
        }
        takeHeld(threadId, item.id);
      }
    }
  } finally {
    flushing = false;
  }
}

useApp.subscribe((state, previous) => {
  if (state.connected && !previous.connected) void flushHeld();
});
