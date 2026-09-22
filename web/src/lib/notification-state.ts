import { playUiSound } from "./ui-sound.ts";
import type { AppState } from "./app-state.ts";
import type { ServerEvent } from "../../../shared/protocol.ts";

export function playAlert(level: "success" | "error" | "attention"): void {
  playUiSound(level === "attention" ? "attention" : level === "success" ? "done" : "error");
}

export function applyNotificationEvent(
  state: AppState,
  event: Extract<
    ServerEvent,
    { t: "notification.add" } | { t: "notifications.update" } | { t: "notifications.preferences" }
  >,
): void {
  switch (event.t) {
    case "notification.add": {
      const { notification } = event;
      if (state.notifications.some(entry => entry.id === notification.id)) return;
      const target = notification.target;
      const focused = typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();
      const readingChat = notification.kind === "chat" && target.threadId === state.readingThreadId;
      const viewingWorkspace = focused && ["git", "github"].includes(notification.kind) &&
        target.view === state.activeView && target.projectId === state.activeProjectId &&
        (!target.threadId || target.threadId === state.activeThreadId);
      const seen = notification.level === "success" && (readingChat || viewingWorkspace);
      state.notifications = [
        seen ? { ...notification, read: true } : notification,
        ...state.notifications,
      ].slice(0, 100);
      if (!seen && notification.level !== "info") playAlert(notification.level);
      if (state.notificationPreferences.toasts && !seen)
        state.toasts = [
          ...state.toasts,
          {
            id: notification.id,
            title: notification.title,
            text: notification.text,
            level: notification.level,
            target,
          },
        ];
      return;
    }
    case "notifications.update":
      state.notifications = event.notifications;
      return;
    case "notifications.preferences":
      state.notificationPreferences = { ...state.notificationPreferences, ...event.preferences };
      return;
  }
}

export function restoreSnapshotNotifications(
  state: AppState,
  snapshot: Extract<ServerEvent, { t: "hello" }>["snapshot"],
): void {
  state.notifications = snapshot.notifications ?? [];
  state.notificationPreferences = {
    toasts: true,
    desktop: true,
    sound: false,
    subagents: false,
    ...snapshot.notificationPreferences,
  };
}
