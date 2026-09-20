import type { AppNotification, Thread } from "../shared/protocol.ts";

const titleLimit = 60;
const textLimit = 160;

function clip(text: string, limit: number, tail = false): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return tail ? `…${flat.slice(-(limit - 1))}` : `${flat.slice(0, limit - 1)}…`;
}

function finalText(child: Thread): string {
  const message = child.messages.findLast((entry) => entry.role === "assistant" && entry.parts.some((part) => part.kind === "text"));
  const text = message?.parts.findLast((part) => part.kind === "text");
  return text?.kind === "text" ? text.text : "";
}

export function subagentFinishedNotification(child: Thread): Omit<AppNotification, "id" | "createdAt" | "read"> {
  const failed = child.status === "error";
  const detail = child.error ? clip(child.error, textLimit) : clip(finalText(child), textLimit, true);
  const outcome = failed ? "failed" : "finished";
  return {
    title: `${clip(child.title, titleLimit)} ${outcome}`,
    text: detail || "No final message.",
    kind: "chat",
    level: failed ? "error" : "success",
    dedupeKey: `subagent:${child.id}:${child.runCount ?? 0}`,
    target: { view: "chat", projectId: child.projectId, threadId: child.parentThreadId },
  };
}
