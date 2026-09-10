import type { ThreadMeta } from "../../../shared/protocol.ts";

export function groupSubagents(children: ThreadMeta[]) {
  const latest = children.reduce<ThreadMeta | undefined>(
    (latest, child) =>
      !latest || child.createdAt > latest.createdAt ? child : latest,
    undefined,
  );
  const current: ThreadMeta[] = [];
  const earlier: ThreadMeta[] = [];
  for (const child of children) {
    const active =
      child.running ||
      ["thinking", "working", "awaiting", "queued"].includes(child.status);
    (active || child.parentMessageId === latest?.parentMessageId
      ? current
      : earlier
    ).push(child);
  }
  return { current, earlier };
}
