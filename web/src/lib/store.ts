import { resolveResponse } from "./requests.ts";
import type { ComputerState } from "../../../shared/computer.ts";
import "./migrate-preferences.ts";
import { create } from "zustand";
import type {
  BrowserState,
  PanelTab,
  ToolConnection,
  ToolDefinition,
} from "../../../shared/workbench.ts";
import type {
  GitStatus,
  Message,
  Part,
  PermissionRequest,
  Project,
  ProviderInfo,
  ServerEvent,
  ThreadMeta,
  AppNotification,
  NotificationPreferences,
  NotificationTarget,
} from "../../../shared/protocol.ts";

export interface MessageShell {
  id: string;
  role: Message["role"];
  ts: number;
  model?: string;
  partIds: string[];
  attachments?: Message["attachments"];
}

export interface Toast {
  id: string;
  level: "info" | "warn" | "error" | "success";
  text: string;
  title?: string;
  target?: NotificationTarget;
}

export interface Confirmation {
  title: string;
  description: string;
  label: string;
  context?: string;
  danger?: boolean;
  resolve: (confirmed: boolean) => void;
}

export type Theme = "dark" | "light";
export type PanelId = "sidebar" | "inspector" | "git" | "github";

export interface AppState {
  newThreadProvider: import("../../../shared/protocol.ts").ProviderId | null;
  notifications: AppNotification[];
  notificationPreferences: NotificationPreferences;
  confirmation: Confirmation | null;
  searchResult: {
    query: string;
    projectId?: string;
    results: Array<{ threadId: string; messageId?: string; snippet: string }>;
  } | null;
  searchMessageId: string | null;
  connected: boolean;
  choosingWorkspace: boolean;
  home: string;
  projects: Project[];
  providers: ProviderInfo[];
  threads: Record<string, ThreadMeta>;
  threadOrder: string[];
  messages: Record<string, MessageShell>;
  parts: Record<string, Part>;
  reveals: Record<string, true>;
  order: Record<string, string[]>;
  loaded: Record<string, boolean>;
  git: Record<string, GitStatus>;
  permissions: PermissionRequest[];
  toasts: Toast[];
  activeProjectId: string | null;
  activeThreadId: string | null;
  followRequest: number;
  readingThreadId: string | null;
  panels: PanelTab[];
  activePanels: Record<string, string>;
  browsers: Record<string, BrowserState>;
  computer: ComputerState;
  toolConnections: Record<string, ToolConnection>;
  tools: ToolDefinition[];
  inspectorOpen: boolean;
  sidebarOpen: boolean;
  theme: Theme;
  uiScale: number;
  panelWidths: Partial<Record<PanelId, number>>;
  textStreaming: boolean;
  typingAnimation: boolean;
  typingSpeed: number;
}

function readPref<T extends string>(key: string, fallback: T): T {
  if (typeof localStorage === "undefined") return fallback;
  return (localStorage.getItem(key) as T | null) ?? fallback;
}

function readFlag(key: string, fallback: boolean): boolean {
  if (typeof localStorage === "undefined") return fallback;
  const value = localStorage.getItem(key);
  return value === null ? fallback : value === "1";
}

const storedScale = Number(readPref("citropy.uiScale", "120"));
const initialScale =
  Number.isFinite(storedScale) && storedScale >= 90 && storedScale <= 150
    ? storedScale
    : 120;
const storedSpeed = Number(readPref("citropy.typingSpeed", "100"));

function readPanelWidths(): Partial<Record<PanelId, number>> {
  try {
    const stored = JSON.parse(readPref("citropy.panelWidths", "{}"));
    return Object.fromEntries(
      ["sidebar", "inspector", "git", "github"]
        .filter((key) => Number.isFinite(stored?.[key]) && stored[key] > 0)
        .map((key) => [key, stored[key]]),
    );
  } catch {
    return {};
  }
}

export const useApp = create<AppState>(() => ({
  newThreadProvider: null,
  notifications: [],
  notificationPreferences: { toasts: true, desktop: true, sound: false },
  confirmation: null,
  searchResult: null,
  searchMessageId: null,
  connected: false,
  choosingWorkspace: false,
  home: "",
  projects: [],
  providers: [],
  threads: {},
  threadOrder: [],
  messages: {},
  parts: {},
  reveals: {},
  order: {},
  loaded: {},
  git: {},
  permissions: [],
  toasts: [],
  activeProjectId: localStorage.getItem("citropy.project"),
  activeThreadId: localStorage.getItem("citropy.thread"),
  followRequest: 0,
  readingThreadId: null,
  panels: [],
  activePanels: {},
  browsers: {},
  computer: { enabled: false, status: "idle", control: false, displays: [], activity: [] },
  toolConnections: {},
  tools: [],
  inspectorOpen: readFlag(
    "citropy.inspector",
    typeof window !== "undefined" &&
      window.innerWidth / (initialScale / 100) > 1150,
  ),
  sidebarOpen: readFlag(
    "citropy.sidebar",
    typeof window !== "undefined" &&
      window.innerWidth / (initialScale / 100) > 720,
  ),
  theme: readPref<Theme>(
    "citropy.theme",
    typeof window !== "undefined" && window.citropyDesktop ? "dark" : "light",
  ),
  uiScale: initialScale,
  panelWidths: readPanelWidths(),
  textStreaming: readFlag("citropy.textStreaming", true),
  typingAnimation: readFlag("citropy.typingAnimation", false),
  typingSpeed:
    Number.isFinite(storedSpeed) && storedSpeed >= 20 && storedSpeed <= 300
      ? storedSpeed
      : 100,
}));

export function setPanelWidth(panel: PanelId, width?: number): void {
  if (width !== undefined && (!Number.isFinite(width) || width <= 0)) return;
  const panelWidths = { ...useApp.getState().panelWidths };
  if (width === undefined) delete panelWidths[panel];
  else panelWidths[panel] = Math.round(width);
  useApp.setState({ panelWidths });
  localStorage.setItem("citropy.panelWidths", JSON.stringify(panelWidths));
}

function normalize(
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
      attachments: message.attachments,
      partIds,
    };
    ids.push(message.id);
  }
  state.order[threadId] = ids;
  state.loaded[threadId] = true;
}

function removeMessages(state: AppState, threadId: string): void {
  for (const id of state.order[threadId] ?? []) {
    for (const partId of state.messages[id]?.partIds ?? []) {
      delete state.parts[partId];
      delete state.reveals[partId];
    }
    delete state.messages[id];
  }
  delete state.order[threadId];
  delete state.loaded[threadId];
}

type HistoryCollection = "messages" | "parts" | "order" | "loaded" | "reveals";
const historyChanges: Partial<Record<ServerEvent["t"], HistoryCollection[]>> = {
  "thread.remove": ["messages", "parts", "order", "loaded", "reveals"],
  "thread.messages": ["messages", "parts", "order", "loaded", "reveals"],
  "message.add": ["messages", "parts", "order", "reveals"],
  "part.add": ["messages", "parts", "reveals"],
  "part.append": ["parts"],
  "part.patch": ["parts"],
};

export function applyEvents(
  previous: AppState,
  events: ServerEvent[],
): AppState {
  const state = { ...previous };
  const copied = new Set<HistoryCollection>();
  for (const event of events) {
    for (const key of historyChanges[event.t] ?? []) {
      if (copied.has(key)) continue;
      Object.assign(state, { [key]: { ...state[key] } });
      copied.add(key);
    }
    applyEvent(state, event);
  }
  return state;
}

function sortThreads(state: AppState): void {
  state.threadOrder = Object.values(state.threads)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((thread) => thread.id);
}

export function applyEvent(state: AppState, event: ServerEvent): void {
  if (event.t === "computer.state") {
    state.computer = event.computer;
    return;
  }
  switch (event.t) {
    case "request.error":
      resolveResponse(event.requestId, undefined, event.error);
      return;
    case "notification.add": {
      if (
        state.notifications.some((entry) => entry.id === event.notification.id)
      )
        return;
      const seen =
        event.notification.kind === "chat" &&
        event.notification.level === "success" &&
        event.notification.target.threadId === state.readingThreadId;
      state.notifications = [
        seen ? { ...event.notification, read: true } : event.notification,
        ...state.notifications,
      ].slice(0, 100);
      if (state.notificationPreferences.toasts && !seen)
        state.toasts = [
          ...state.toasts,
          {
            id: event.notification.id,
            title: event.notification.title,
            text: event.notification.text,
            level: event.notification.level,
            target: event.notification.target,
          },
        ];
      return;
    }
    case "notifications.update":
      state.notifications = event.notifications;
      return;
    case "notifications.preferences":
      state.notificationPreferences = event.preferences;
      return;
    case "panel.upsert": {
      const exists = state.panels.some((panel) => panel.id === event.panel.id);
      state.panels = exists
        ? state.panels.map((panel) =>
            panel.id === event.panel.id ? event.panel : panel,
          )
        : [...state.panels, event.panel];
      if (
        !state.activePanels[event.panel.projectId] ||
        (!exists &&
          (!event.panel.threadId ||
            event.panel.threadId === state.activeThreadId))
      )
        state.activePanels = {
          ...state.activePanels,
          [event.panel.projectId]: event.panel.id,
        };
      return;
    }
    case "panel.remove": {
      const removed = state.panels.find((panel) => panel.id === event.id);
      state.panels = state.panels.filter((panel) => panel.id !== event.id);
      if (removed && state.activePanels[removed.projectId] === event.id)
        state.activePanels = {
          ...state.activePanels,
          [removed.projectId]:
            state.panels.findLast(
              (panel) => panel.projectId === removed.projectId,
            )?.id ?? "",
        };
      const { [event.id]: browser, ...browsers } = state.browsers;
      state.browsers = browsers;
      return;
    }
    case "browser.state":
      state.browsers = { ...state.browsers, [event.browser.id]: event.browser };
      return;
    case "tools.connection":
      state.toolConnections = {
        ...state.toolConnections,
        [event.connection.threadId]: event.connection,
      };
      return;
    case "project.chosen": {
      state.choosingWorkspace = false;
      if (event.projectId) {
        state.activeProjectId = event.projectId;
        state.activeThreadId = null;
        localStorage.setItem("citropy.project", event.projectId);
        localStorage.removeItem("citropy.thread");
      }
      if (event.error)
        state.toasts = [
          ...state.toasts,
          { id: `folder-${Date.now()}`, level: "error", text: event.error },
        ];
      return;
    }
    case "providers.update":
      state.providers = event.providers;
      return;
    case "github.result":
      resolveResponse(
        event.requestId,
        event.result,
        event.error ??
          (event.result === undefined
            ? "GitHub returned no result."
            : undefined),
      );
      return;
    case "git.manage":
      resolveResponse(event.requestId, event.result ?? "", event.error);
      return;
    case "thread.search":
      state.searchResult = event;
      return;
    case "hello": {
      state.computer = event.snapshot.computer ?? { enabled: false, status: "idle", control: false, displays: [], activity: [] };
      state.notifications = event.snapshot.notifications ?? [];
      state.notificationPreferences = event.snapshot
        .notificationPreferences ?? {
        toasts: true,
        desktop: true,
        sound: false,
      };
      state.panels = event.snapshot.panels ?? [];
      state.browsers = Object.fromEntries(
        (event.snapshot.browsers ?? []).map((browser) => [browser.id, browser]),
      );
      state.tools = event.snapshot.tools ?? [];
      state.toolConnections = Object.fromEntries(
        (event.snapshot.toolConnections ?? []).map((connection) => [
          connection.threadId,
          connection,
        ]),
      );
      state.connected = true;
      state.choosingWorkspace = false;
      state.permissions = event.snapshot.permissions;
      state.home = event.snapshot.home;
      state.projects = event.snapshot.projects;
      state.providers = event.snapshot.providers;
      state.threads = Object.fromEntries(
        event.snapshot.threads.map((thread) => [thread.id, thread]),
      );
      state.messages = {};
      state.parts = {};
      state.reveals = {};
      state.order = {};
      state.loaded = {};
      state.activePanels = Object.fromEntries(
        Object.entries(state.activePanels).filter(([, id]) =>
          state.panels.some((panel) => panel.id === id),
        ),
      );
      state.git = Object.fromEntries(
        Object.entries(state.git).filter(([id]) =>
          state.projects.some((project) => project.id === id),
        ),
      );
      sortThreads(state);
      if (
        !state.activeProjectId ||
        !state.projects.some((p) => p.id === state.activeProjectId)
      ) {
        state.activeProjectId = state.projects[0]?.id ?? null;
      }
      if (state.activeThreadId && !state.threads[state.activeThreadId])
        state.activeThreadId = null;
      if (
        typeof window !== "undefined" &&
        window.citropyDesktop &&
        !Object.keys(state.activePanels).length
      ) {
        const browser = state.panels.findLast(
          (panel) => panel.kind === "browser",
        );
        if (browser) {
          state.activeProjectId = browser.projectId;
          state.activeThreadId = browser.threadId ?? state.activeThreadId;
          state.activePanels = { [browser.projectId]: browser.id };
          state.inspectorOpen = true;
        }
      }
      return;
    }
    case "project.upsert": {
      const index = state.projects.findIndex((p) => p.id === event.project.id);
      state.projects =
        index === -1
          ? [event.project, ...state.projects]
          : state.projects.map((p) =>
              p.id === event.project.id ? event.project : p,
            );
      if (!state.activeProjectId) state.activeProjectId = event.project.id;
      return;
    }
    case "project.remove": {
      state.projects = state.projects.filter((p) => p.id !== event.id);
      const { [event.id]: git, ...remainingGit } = state.git;
      const { [event.id]: panel, ...remainingPanels } = state.activePanels;
      state.git = remainingGit;
      state.activePanels = remainingPanels;
      if (state.activeProjectId === event.id)
        state.activeProjectId = state.projects[0]?.id ?? null;
      return;
    }
    case "thread.upsert": {
      state.threads = { ...state.threads, [event.thread.id]: event.thread };
      sortThreads(state);
      return;
    }
    case "thread.remove": {
      const { [event.id]: removed, ...rest } = state.threads;
      void removed;
      state.threads = rest;
      removeMessages(state, event.id);
      const { [event.id]: connection, ...remainingConnections } =
        state.toolConnections;
      state.toolConnections = remainingConnections;
      sortThreads(state);
      if (state.activeThreadId === event.id) state.activeThreadId = null;
      return;
    }
    case "thread.accepted":
      resolveResponse(event.requestId);
      return;
    case "thread.messages": {
      normalize(state, event.threadId, event.messages);
      return;
    }
    case "message.add": {
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
      state.parts[event.partId] = { ...part, text: part.text + event.text };
      return;
    }
    case "part.patch": {
      const part = state.parts[event.partId];
      if (!part) return;
      state.parts[event.partId] = { ...part, ...event.patch } as Part;
      return;
    }
    case "permission.request": {
      state.permissions = [...state.permissions, event.request];
      return;
    }
    case "permission.close": {
      state.permissions = state.permissions.filter(
        (request) => request.id !== event.id,
      );
      return;
    }
    case "git.status": {
      const active = state.threads[state.activeThreadId ?? ""];
      if (event.threadId && active?.id !== event.threadId) return;
      if (
        !event.threadId &&
        active?.workspacePath &&
        active.workspacePath !==
          state.projects.find((project) => project.id === active.projectId)
            ?.path
      )
        return;
      state.git = { ...state.git, [event.projectId]: event.status };
      return;
    }
    case "git.diff": {
      resolveResponse(event.requestId, event.patch, event.error);
      return;
    }
    case "file.tree": {
      resolveResponse(event.requestId, event.entries);
      return;
    }
    case "file.content": {
      resolveResponse(event.requestId, event.content);
      return;
    }
    case "toast": {
      state.toasts = [
        ...state.toasts,
        {
          id: `${Date.now()}${Math.random()}`,
          level: event.level,
          text: event.text,
        },
      ];
      return;
    }
    default:
      return;
  }
}

export function selectThread(id: string | null): void {
  useApp.setState((state) => {
    if (state.activeThreadId === id) return state;
    const git = { ...state.git };
    const projectId = id ? state.threads[id]?.projectId : state.activeProjectId;
    if (projectId) delete git[projectId];
    return { activeThreadId: id, git };
  });
  if (id) localStorage.setItem("citropy.thread", id);
  else localStorage.removeItem("citropy.thread");
}

export function selectProject(id: string): void {
  useApp.setState({ activeProjectId: id, activeThreadId: null });
  localStorage.removeItem("citropy.thread");
  localStorage.setItem("citropy.project", id);
}

export function setTheme(theme: Theme): void {
  useApp.setState({ theme });
  localStorage.setItem("citropy.theme", theme);
  document.documentElement.dataset.theme = theme;
}

export function selectPanel(id: string): void {
  const panel = useApp.getState().panels.find((entry) => entry.id === id);
  if (!panel) return;
  useApp.setState((state) => ({
    activePanels: { ...state.activePanels, [panel.projectId]: id },
    inspectorOpen: true,
  }));
  localStorage.setItem("citropy.inspector", "1");
}

export function toggleInspector(): void {
  const next = !useApp.getState().inspectorOpen;
  useApp.setState({ inspectorOpen: next });
  localStorage.setItem("citropy.inspector", next ? "1" : "0");
}

export function toggleSidebar(): void {
  const next = !useApp.getState().sidebarOpen;
  useApp.setState({ sidebarOpen: next });
  localStorage.setItem("citropy.sidebar", next ? "1" : "0");
}

export function dismissToast(id: string): void {
  useApp.setState((state) => ({
    toasts: state.toasts.filter((toast) => toast.id !== id),
  }));
}

export function confirmAction(
  options: Omit<Confirmation, "resolve">,
): Promise<boolean> {
  if (useApp.getState().confirmation) return Promise.resolve(false);
  return new Promise((resolve) =>
    useApp.setState({ confirmation: { ...options, resolve } }),
  );
}

export function answerConfirmation(confirmed: boolean): void {
  const pending = useApp.getState().confirmation;
  useApp.setState({ confirmation: null });
  pending?.resolve(confirmed);
}

export function setUiScale(value: number): void {
  const uiScale = Math.max(90, Math.min(150, Math.round(value)));
  if (!Number.isFinite(uiScale)) return;
  useApp.setState({ uiScale });
  localStorage.setItem("citropy.uiScale", String(uiScale));
  document.documentElement.style.setProperty(
    "--ui-scale",
    String(uiScale / 100),
  );
}

export function setTextStreaming(value: boolean): void {
  useApp.setState({ textStreaming: value });
  localStorage.setItem("citropy.textStreaming", value ? "1" : "0");
}

export function setTypingAnimation(value: boolean): void {
  useApp.setState({ typingAnimation: value });
  localStorage.setItem("citropy.typingAnimation", value ? "1" : "0");
}

export function setTypingSpeed(value: number): void {
  if (!Number.isFinite(value)) return;
  const typingSpeed = Math.max(20, Math.min(300, Math.round(value)));
  useApp.setState({ typingSpeed });
  localStorage.setItem("citropy.typingSpeed", String(typingSpeed));
}

export function markTextPresented(id: string): void {
  if (!useApp.getState().reveals[id]) return;
  useApp.setState((state) => {
    const { [id]: presented, ...reveals } = state.reveals;
    return { reveals };
  });
}

export function viewportWidth(): number {
  return window.innerWidth / (useApp.getState().uiScale / 100);
}
