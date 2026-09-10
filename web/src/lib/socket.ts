import { applyEvents, useApp } from "./store.ts";
import { rejectResponses, resolveResponse } from "./requests.ts";
import type { ClientEvent, ServerEvent } from "../../../shared/protocol.ts";

type TermListener = (
  event: Extract<ServerEvent, { t: "term.data" } | { t: "term.exit" }>,
) => void;

const termListeners = new Set<TermListener>();
let socket: WebSocket | null = null;
let queue: ServerEvent[] = [];
let frame = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let backoff = 400;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const outbox: ClientEvent[] = [];

function flush(): void {
  if (frame) cancelAnimationFrame(frame);
  if (timer) clearTimeout(timer);
  frame = 0;
  timer = null;
  const batch = queue;
  queue = [];
  if (batch.length === 0) return;
  useApp.setState((previous) => applyEvents(previous, batch));
  const notifications = useApp.getState().notifications;
  const read: string[] = [];
  for (const event of batch) {
    if (
      event.t === "notification.add" &&
      !event.notification.read &&
      notifications.some(
        (notification) =>
          notification.id === event.notification.id && notification.read,
      )
    )
      read.push(event.notification.id);
  }
  if (read.length) send({ t: "notifications.read", ids: read });
}

function enqueue(event: ServerEvent): void {
  queue.push(event);
  if (frame === 0) frame = requestAnimationFrame(flush);
  if (timer === null) timer = setTimeout(flush, 40);
}

export function onTerminal(listener: TermListener): () => void {
  termListeners.add(listener);
  return () => termListeners.delete(listener);
}

export function send(event: ClientEvent): void {
  if (
    (event.t.startsWith("git.") ||
      event.t.startsWith("file.") ||
      event.t === "term.open") &&
    "projectId" in event &&
    !event.threadId
  ) {
    const state = useApp.getState();
    const thread = state.threads[state.activeThreadId ?? ""];
    if (thread && thread.projectId === event.projectId)
      event = { ...event, threadId: thread.id };
  }
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(event));
    return;
  }
  if ("requestId" in event && event.requestId) {
    resolveResponse(
      event.requestId,
      undefined,
      "Citropy is reconnecting. This request was not sent.",
    );
    return;
  }
  if (
    [
      "browser.action",
      "desktop.open",
      "panel.open",
      "panel.close",
      "term.data",
    ].includes(event.t)
  )
    return;
  outbox.push(event);
}

export function connect(): void {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  )
    return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const current = new WebSocket(`${protocol}://${location.host}/socket`);
  socket = current;

  current.onopen = () => {
    if (socket !== current) return;
    backoff = 400;
    while (outbox.length) {
      const event = outbox.shift();
      if (event) current.send(JSON.stringify(event));
    }
  };

  current.onmessage = (message) => {
    if (socket !== current) return;
    const event = JSON.parse(message.data as string) as ServerEvent;
    if (event.t === "term.data" || event.t === "term.exit") {
      for (const listener of termListeners) listener(event);
      return;
    }
    enqueue(event);
  };

  current.onclose = () => {
    if (socket !== current) return;
    flush();
    useApp.setState({ connected: false });
    rejectResponses();
    socket = null;
    reconnectTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 1.7, 8000);
  };

  current.onerror = () => current.close();
}

export function disconnect(): void {
  flush();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const current = socket;
  socket = null;
  if (current) {
    current.onopen = null;
    current.onmessage = null;
    current.onclose = null;
    current.onerror = null;
    current.close();
  }
  outbox.length = 0;
  termListeners.clear();
  rejectResponses();
  useApp.setState({ connected: false });
}

if (import.meta.hot) import.meta.hot.dispose(disconnect);

let counter = 0;
export function requestId(): string {
  counter += 1;
  return `req${counter}_${Date.now().toString(36)}`;
}
