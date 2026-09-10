import { randomBytes, timingSafeEqual } from "node:crypto";
import { origin } from "./config.ts";
import { bus } from "./bus.ts";
import type { ToolConnection } from "../shared/workbench.ts";

const connections = new Map<string, { token: string; state: ToolConnection }>();

export function connectTools(threadId: string): {
  url: string;
  headers: Record<string, string>;
} {
  let entry = connections.get(threadId);
  if (!entry) {
    entry = {
      token: randomBytes(32).toString("hex"),
      state: { threadId, connected: false },
    };
    connections.set(threadId, entry);
  }
  return {
    url: `${origin}/mcp/${threadId}`,
    headers: { Authorization: `Bearer ${entry.token}` },
  };
}

export function authorizeTools(
  threadId: string,
  authorization: string | undefined,
): boolean {
  const token = connections.get(threadId)?.token;
  if (!token || !authorization) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const supplied = Buffer.from(authorization);
  return (
    expected.length === supplied.length && timingSafeEqual(expected, supplied)
  );
}

export function touchTools(threadId: string): void {
  const entry = connections.get(threadId);
  if (!entry) return;
  entry.state = { threadId, connected: true, lastUsed: Date.now() };
  bus.emit({ t: "tools.connection", connection: entry.state });
}

export function disconnectTools(threadId: string): void {
  if (!connections.delete(threadId)) return;
  bus.emit({
    t: "tools.connection",
    connection: { threadId, connected: false },
  });
}

export function toolConnections(): ToolConnection[] {
  return [...connections.values()].map((entry) => entry.state);
}
