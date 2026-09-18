import type { TodoItem } from "./protocol.ts";

export function normalizeTodos(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return [];
  const items: TodoItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const text = [entry.text, entry.content, entry.step]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
    if (!text) continue;
    let status: TodoItem["status"] = "pending";
    if (entry.status === "in_progress" || entry.status === "inProgress") status = "in_progress";
    else if (entry.status === "completed" || entry.status === "cancelled") status = entry.status;
    items.push({ text, status });
  }
  return items;
}
