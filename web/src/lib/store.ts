import type { QuestionRequest } from "../../../shared/questions.ts";
import { environmentStorage } from "./environment.ts";
import { resolveResponse } from "./requests.ts";
import { playUiSound } from "./ui-sound.ts";
import type { ComputerState } from "../../../shared/computer.ts";
import "./migrate-preferences.ts";
import { create } from "zustand";
import { defaultAssistance, type AssistanceSettings, type WritingModel } from "../../../shared/assistance.ts";
import type { Language } from "./translations.ts";
import type { GitHubUser } from "../../../shared/github.ts";
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
  ProjectSettings,
  ProviderInfo,
  ServerEvent,
  ThreadMeta,
  QueuedMessage,
  AppNotification,
  NotificationPreferences,
  NotificationTarget,
  ShellProcess,
} from "../../../shared/protocol.ts";

export interface MessageShell {
  provider?: Message["provider"];
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
  shells: Record<string, ShellProcess>;
  projectDefaults: ProjectSettings;
  assistance: AssistanceSettings;
  activeView: "chat" | "git" | "github" | "settings" | "usage";
  newThreadProvider: import("../../../shared/protocol.ts").ProviderId | null;
  creatingThread: boolean;
  threadDefaults: Pick<ThreadMeta, "provider" | "model" | "effort" | "contextWindow" | "fastMode"> | null;
  favoriteModels: WritingModel[];
  notifications: AppNotification[];
  notificationPreferences: NotificationPreferences;
  confirmation: Confirmation | null;
  searchResult: {
    query: string;
    projectId?: string;
    results: Array<{ threadId: string; messageId?: string; snippet: string }>;
  } | null;
  searchMessageId: string | null;
  searchShellId: string | null;
  connected: boolean;
  development: boolean;
  githubAccount: GitHubUser | null;
  showGitHubIdentity: boolean;
  offline: Record<string, QueuedMessage[]>;
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
  historyBytes: Record<string, number>;
  disclosures: Record<string, Record<string, boolean>>;
  git: Record<string, GitStatus>;
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  questionDrafts: Record<string, { index: number; choices: Record<string, string[]>; text: Record<string, string> }>;
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
  gitPanelOpen: boolean;
  sidebarOpen: boolean;
  theme: Theme;
  language: Language;
  uiScale: number;
  panelWidths: Partial<Record<PanelId, number>>;
  textStreaming: boolean;
  typingAnimation: boolean;
  typingSpeed: number;
  uiSounds: boolean;
  uiAlertSounds: boolean;
  uiSoundVolume: number;
}

function readPref<T extends string>(key: string, fallback: T): T {
  if (typeof localStorage === "undefined") return fallback;
  return (environmentStorage.getItem(key) as T | null) ?? fallback;
}

function readFlag(key: string, fallback: boolean): boolean {
  if (typeof localStorage === "undefined") return fallback;
  const value = environmentStorage.getItem(key);
  return value === null ? fallback : value === "1";
}

const storedScale = Number(readPref("citropy.uiScale", "120"));
const initialScale =
  Number.isFinite(storedScale) && storedScale >= 90 && storedScale <= 150
    ? storedScale
    : 120;
const storedSpeed = Number(readPref("citropy.typingSpeed", "100"));
const storedVolume = Number(readPref("citropy.uiSoundVolume", "60"));

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

function readOffline(): Record<string, QueuedMessage[]> {
  try {
    const stored = JSON.parse(readPref("citropy.offline", "{}"));
    return stored && typeof stored === "object" && !Array.isArray(stored)
      ? stored
      : {};
  } catch {
    return {};
  }
}

function readThreadDefaults(): AppState["threadDefaults"] {
  try {
    const value = JSON.parse(readPref("citropy.threadDefaults", "null"));
    return value && ["claude", "codex", "opencode"].includes(value.provider) &&
      (value.model === undefined || typeof value.model === "string") &&
      (value.effort === undefined || typeof value.effort === "string") ? value : null;
  } catch {
    return null;
  }
}

function readFavoriteModels(): WritingModel[] {
  try {
    const value = JSON.parse(readPref("citropy.favoriteModels", "[]"));
    return Array.isArray(value) ? value.filter((entry) => entry && ["claude", "codex", "opencode"].includes(entry.provider) && typeof entry.model === "string") : [];
  } catch {
    return [];
  }
}

export const useApp = create<AppState>(() => ({
  shells: {},
  newThreadProvider: null,
  creatingThread: false,
  threadDefaults: readThreadDefaults(),
  favoriteModels: readFavoriteModels(),
  notifications: [],
  assistance: { ...defaultAssistance },
  projectDefaults: {},
  activeView: "chat",
  gitPanelOpen: readFlag("citropy.gitPanel", false),
  notificationPreferences: { toasts: true, desktop: true, sound: false },
  confirmation: null,
  searchResult: null,
  searchMessageId: null,
  searchShellId: null,
  connected: false,
  development: false,
  githubAccount: null,
  showGitHubIdentity: readFlag("citropy.showGitHubIdentity", true),
  offline: readOffline(),
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
  historyBytes: {},
  disclosures: {},
  git: {},
  permissions: [],
  questions: [],
  questionDrafts: {},
  toasts: [],
  activeProjectId: typeof localStorage === "undefined" ? null : environmentStorage.getItem("citropy.project"),
  activeThreadId: typeof localStorage === "undefined" ? null : environmentStorage.getItem("citropy.thread"),
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
  language: readPref<Language>("citropy.language", "en") === "es" ? "es" : "en",
  panelWidths: readPanelWidths(),
  textStreaming: readFlag("citropy.textStreaming", true),
  typingAnimation: readFlag("citropy.typingAnimation", false),
  typingSpeed:
    Number.isFinite(storedSpeed) && storedSpeed >= 20 && storedSpeed <= 300
      ? storedSpeed
      : 100,
  uiSounds: readFlag("citropy.uiSounds", true),
  uiAlertSounds: readFlag("citropy.uiAlertSounds", true),
  uiSoundVolume: Number.isFinite(storedVolume)
    ? Math.max(0, Math.min(100, storedVolume))
    : 60,
}));

export function resetEnvironment(projects: Project[], home: string): void {
  useApp.getState().confirmation?.resolve(false);
  useApp.setState({
    shells: {},
    projectDefaults: {},
    assistance: { ...defaultAssistance },
    newThreadProvider: null,
    creatingThread: false,
    notifications: [],
    notificationPreferences: { toasts: true, desktop: true, sound: false },
    confirmation: null,
    searchResult: null,
    searchMessageId: null,
    searchShellId: null,
    connected: false,
  development: false,
    githubAccount: null,
    offline: readOffline(),
    choosingWorkspace: false,
    home,
    projects,
    providers: [],
    threads: {},
    threadOrder: [],
    messages: {},
    parts: {},
    reveals: {},
    order: {},
    loaded: {},
    historyBytes: {},
    disclosures: {},
    git: {},
    permissions: [],
    questions: [],
    questionDrafts: {},
    toasts: [],
    activeProjectId: environmentStorage.getItem("citropy.project"),
    activeThreadId: environmentStorage.getItem("citropy.thread"),
    followRequest: 0,
    readingThreadId: null,
    panels: [],
    activePanels: {},
    browsers: {},
    computer: { enabled: false, status: "idle", control: false, displays: [], activity: [] },
    toolConnections: {},
    tools: [],
  });
}

export function toggleFavoriteModel(model: WritingModel): void {
  const current = useApp.getState().favoriteModels;
  const exists = current.some((entry) => entry.provider === model.provider && entry.model === model.model);
  const favoriteModels = exists ? current.filter((entry) => entry.provider !== model.provider || entry.model !== model.model) : [...current, model];
  useApp.setState({ favoriteModels });
  environmentStorage.setItem("citropy.favoriteModels", JSON.stringify(favoriteModels));
}

export function setPanelWidth(panel: PanelId, width?: number): void {
  if (width !== undefined && (!Number.isFinite(width) || width <= 0)) return;
  const panelWidths = { ...useApp.getState().panelWidths };
  if (width === undefined) delete panelWidths[panel];
  else panelWidths[panel] = Math.round(width);
  useApp.setState({ panelWidths });
  environmentStorage.setItem("citropy.panelWidths", JSON.stringify(panelWidths));
}

export function setLanguage(language: Language): void {
  if (language !== "en" && language !== "es") return;
  useApp.setState({ language });
  environmentStorage.setItem("citropy.language", language);
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

function removeMessages(state: AppState, threadId: string): void {
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

type HistoryCollection = "messages" | "parts" | "order" | "loaded" | "reveals" | "historyBytes" | "disclosures";
const allHistory: HistoryCollection[] = [
  "messages", "parts", "order", "loaded", "reveals", "historyBytes", "disclosures",
];
const historyChanges: Partial<Record<ServerEvent["t"], HistoryCollection[]>> = {
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

function trimHistories(state: AppState, previousBytes?: number): void {
  const ids = Object.keys(state.loaded);
  if (ids.length <= 4) return;
  const bytesTotal = totalHistoryBytes(state);
  if (previousBytes !== undefined && bytesTotal === previousBytes) return;
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

function unloadedDelta(state: AppState, event: ServerEvent): boolean {
  return (
    (event.t === "message.add" || event.t === "part.add" ||
      event.t === "part.append" || event.t === "part.patch") &&
    !state.loaded[event.threadId]
  );
}

export function applyEvents(
  previous: AppState,
  events: ServerEvent[],
): AppState {
  const state = { ...previous };
  const previousBytes = totalHistoryBytes(previous);
  const copied = new Set<HistoryCollection>();
  for (const event of events) {
    if (unloadedDelta(state, event)) continue;
    for (const key of historyChanges[event.t] ?? []) {
      if (copied.has(key)) continue;
      Object.assign(state, { [key]: { ...state[key] } });
      copied.add(key);
    }
    applyEvent(state, event);
  }
  trimHistories(state, previousBytes);
  return state;
}

function sortThreads(state: AppState): void {
  state.threadOrder = Object.values(state.threads)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((thread) => thread.id);
}

function sameThreadMeta(a: ThreadMeta, b: ThreadMeta): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (key === "updatedAt") continue;
    if (JSON.stringify(a[key as keyof ThreadMeta]) !== JSON.stringify(b[key as keyof ThreadMeta])) return false;
  }
  return true;
}

function playAlert(level: "success" | "error" | "attention"): void {
  playUiSound(level === "attention" ? "attention" : level === "success" ? "done" : "error");
}

function applyShellEvent(
  state: AppState,
  event: Extract<ServerEvent, { t: "shell.upsert" } | { t: "shell.remove" }>,
): void {
  switch (event.t) {
    case "shell.upsert":
      state.shells = { ...state.shells, [event.shell.id]: event.shell };
      return;
    case "shell.remove": {
      const { [event.id]: removed, ...remaining } = state.shells;
      void removed;
      state.shells = remaining;
      return;
    }
  }
}

function applySettingsEvent(
  state: AppState,
  event: Extract<
    ServerEvent,
    { t: "project.defaults" } | { t: "assistance.settings" }
  >,
): void {
  switch (event.t) {
    case "project.defaults":
      state.projectDefaults = event.settings;
      return;
    case "assistance.settings":
      state.assistance = event.settings;
      return;
  }
}

function applyNotificationEvent(
  state: AppState,
  event: Extract<
    ServerEvent,
    { t: "notification.add" } | { t: "notifications.update" } | { t: "notifications.preferences" }
  >,
): void {
  switch (event.t) {
    case "notification.add": {
      if (
        state.notifications.some((entry) => entry.id === event.notification.id)
      )
        return;
      const target = event.notification.target;
      const focused = typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();
      const seen = event.notification.level === "success" && (
        (event.notification.kind === "chat" && target.threadId === state.readingThreadId) ||
        (focused && ["git", "github"].includes(event.notification.kind) &&
          target.view === state.activeView && target.projectId === state.activeProjectId &&
          (!target.threadId || target.threadId === state.activeThreadId))
      );
      state.notifications = [
        seen ? { ...event.notification, read: true } : event.notification,
        ...state.notifications,
      ].slice(0, 100);
      if (!seen && event.notification.level !== "info")
        playAlert(event.notification.level);
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
  }
}

function applyPanelEvent(
  state: AppState,
  event: Extract<
    ServerEvent,
    { t: "panel.upsert" } | { t: "panel.remove" } | { t: "browser.state" } | { t: "tools.connection" }
  >,
): void {
  switch (event.t) {
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
  }
}

function applyProjectEvent(
  state: AppState,
  event: Extract<
    ServerEvent,
    { t: "project.chosen" } | { t: "project.upsert" } | { t: "project.remove" }
  >,
): void {
  switch (event.t) {
    case "project.chosen": {
      state.choosingWorkspace = false;
      if (event.projectId) {
        state.activeProjectId = event.projectId;
        state.activeThreadId = null;
        environmentStorage.setItem("citropy.project", event.projectId);
        environmentStorage.removeItem("citropy.thread");
      }
      if (event.error)
        state.toasts = [
          ...state.toasts,
          { id: `folder-${Date.now()}`, level: "error", text: event.error },
        ];
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
  }
}

function applyThreadEvent(
  state: AppState,
  event: Extract<
    ServerEvent,
    { t: "thread.upsert" } | { t: "thread.remove" } | { t: "thread.accepted" } | { t: "thread.messages" } | { t: "thread.search" }
  >,
): void {
  switch (event.t) {
    case "thread.upsert": {
      const previous = state.threads[event.thread.id];
      if (previous && previous.updatedAt === event.thread.updatedAt && sameThreadMeta(previous, event.thread)) return;
      state.threads = { ...state.threads, [event.thread.id]: event.thread };
      if (!previous || previous.updatedAt !== event.thread.updatedAt) sortThreads(state);
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
    case "thread.search":
      state.searchResult = event;
      return;
  }
}

function applyMessageEvent(
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

function applyPromptEvent(
  state: AppState,
  event: Extract<
    ServerEvent,
    { t: "question.request" } | { t: "question.close" } | { t: "permission.request" } | { t: "permission.close" }
  >,
): void {
  switch (event.t) {
    case "question.request": {
      playAlert("attention");
      state.questions = [...state.questions.filter(question => question.id !== event.request.id), event.request];
      return;
    }
    case "question.close": {
      state.questions = state.questions.filter(question => question.id !== event.id);
      state.questionDrafts = Object.fromEntries(Object.entries(state.questionDrafts).filter(([id]) => id !== event.id));
      return;
    }
    case "permission.request": {
      playAlert("attention");
      state.permissions = [...state.permissions, event.request];
      return;
    }
    case "permission.close": {
      state.permissions = state.permissions.filter(
        (request) => request.id !== event.id,
      );
      return;
    }
  }
}

function applyGitEvent(
  state: AppState,
  event: Extract<
    ServerEvent,
    { t: "git.status" } | { t: "git.diff" } | { t: "git.manage" }
  >,
): void {
  switch (event.t) {
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
    case "git.manage":
      resolveResponse(event.requestId, event.result ?? "", event.error);
      return;
  }
}

function applyFileEvent(
  state: AppState,
  event: Extract<ServerEvent, { t: "file.tree" } | { t: "file.content" }>,
): void {
  switch (event.t) {
    case "file.tree": {
      resolveResponse(event.requestId, event.entries);
      return;
    }
    case "file.content": {
      resolveResponse(event.requestId, event.content);
      return;
    }
  }
}

function applyHelloEvent(
  state: AppState,
  event: Extract<ServerEvent, { t: "hello" }>,
): void {
  const { snapshot } = event;
  restoreSnapshotEnvironment(state, snapshot);
  restoreSnapshotNotifications(state, snapshot);
  restoreSnapshotPanels(state, snapshot);
  state.connected = true;
  state.choosingWorkspace = false;
  state.permissions = snapshot.permissions;
  state.questions = snapshot.questions ?? [];
  state.development = snapshot.development === true;
  state.questionDrafts = Object.fromEntries(Object.entries(state.questionDrafts).filter(([id]) => state.questions.some(question => question.id === id)));
  state.home = snapshot.home;
  state.projects = snapshot.projects;
  state.providers = snapshot.providers;
  restoreSnapshotThreads(state, snapshot);
  restoreSnapshotWorkspace(state, snapshot);
}

function restoreSnapshotEnvironment(
  state: AppState,
  snapshot: Extract<ServerEvent, { t: "hello" }>["snapshot"],
): void {
  state.shells = Object.fromEntries((snapshot.shells ?? []).map(shell => [shell.id, shell]));
  state.projectDefaults = snapshot.projectDefaults ?? {};
  state.assistance = snapshot.assistance ?? { ...defaultAssistance };
  state.computer = snapshot.computer ?? { enabled: false, status: "idle", control: false, displays: [], activity: [] };
}

function restoreSnapshotNotifications(
  state: AppState,
  snapshot: Extract<ServerEvent, { t: "hello" }>["snapshot"],
): void {
  state.notifications = snapshot.notifications ?? [];
  state.notificationPreferences = snapshot.notificationPreferences ?? {
    toasts: true,
    desktop: true,
    sound: false,
  };
}

function restoreSnapshotPanels(
  state: AppState,
  snapshot: Extract<ServerEvent, { t: "hello" }>["snapshot"],
): void {
  state.panels = snapshot.panels ?? [];
  state.browsers = Object.fromEntries(
    (snapshot.browsers ?? []).map((browser) => [browser.id, browser]),
  );
  state.tools = snapshot.tools ?? [];
  state.toolConnections = Object.fromEntries(
    (snapshot.toolConnections ?? []).map((connection) => [
      connection.threadId,
      connection,
    ]),
  );
}

function restoreSnapshotThreads(
  state: AppState,
  snapshot: Extract<ServerEvent, { t: "hello" }>["snapshot"],
): void {
  state.threads = Object.fromEntries(
    snapshot.threads.map((thread) => [thread.id, thread]),
  );
  state.messages = {};
  state.parts = {};
  state.reveals = {};
  state.order = {};
  state.loaded = {};
  state.historyBytes = {};
  state.disclosures = {};
}

function restoreSnapshotWorkspace(
  state: AppState,
  snapshot: Extract<ServerEvent, { t: "hello" }>["snapshot"],
): void {
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
}

export function applyEvent(state: AppState, event: ServerEvent): void {
  if (unloadedDelta(state, event)) return;
  if (event.t === "computer.state") {
    state.computer = event.computer;
    return;
  }
  switch (event.t) {
    case "shell.upsert":
    case "shell.remove":
      applyShellEvent(state, event);
      return;
    case "project.defaults":
    case "assistance.settings":
      applySettingsEvent(state, event);
      return;
    case "notification.add":
    case "notifications.update":
    case "notifications.preferences":
      applyNotificationEvent(state, event);
      return;
    case "panel.upsert":
    case "panel.remove":
    case "browser.state":
    case "tools.connection":
      applyPanelEvent(state, event);
      return;
    case "project.chosen":
    case "project.upsert":
    case "project.remove":
      applyProjectEvent(state, event);
      return;
    case "thread.upsert":
    case "thread.remove":
    case "thread.accepted":
    case "thread.messages":
    case "thread.search":
      applyThreadEvent(state, event);
      return;
    case "message.add":
    case "part.add":
    case "part.append":
    case "part.patch":
      applyMessageEvent(state, event);
      return;
    case "question.request":
    case "question.close":
    case "permission.request":
    case "permission.close":
      applyPromptEvent(state, event);
      return;
    case "git.status":
    case "git.diff":
    case "git.manage":
      applyGitEvent(state, event);
      return;
    case "file.tree":
    case "file.content":
      applyFileEvent(state, event);
      return;
    case "request.error":
      resolveResponse(event.requestId, undefined, event.error);
      return;
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
    case "hello":
      applyHelloEvent(state, event);
      return;
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
    const next = { ...state, activeThreadId: id, searchShellId: null, git };
    if (id && state.loaded[id]) {
      next.loaded = { ...state.loaded };
      delete next.loaded[id];
      next.loaded[id] = true;
    }
    trimHistories(next, totalHistoryBytes(state));
    return next;
  });
  if (id) environmentStorage.setItem("citropy.thread", id);
  else environmentStorage.removeItem("citropy.thread");
}

export function selectProject(id: string): void {
  useApp.setState((state) => {
    const next = { ...state, activeProjectId: id, activeThreadId: null };
    trimHistories(next, totalHistoryBytes(state));
    return next;
  });
  environmentStorage.removeItem("citropy.thread");
  environmentStorage.setItem("citropy.project", id);
}

export function setTheme(theme: Theme): void {
  useApp.setState({ theme });
  environmentStorage.setItem("citropy.theme", theme);
  document.documentElement.dataset.theme = theme;
}

export function selectPanel(id: string): void {
  const panel = useApp.getState().panels.find((entry) => entry.id === id);
  if (!panel) return;
  useApp.setState((state) => ({
    activePanels: { ...state.activePanels, [panel.projectId]: id },
    inspectorOpen: true,
  }));
  environmentStorage.setItem("citropy.inspector", "1");
}

export function toggleInspector(): void {
  const next = !useApp.getState().inspectorOpen;
  useApp.setState({ inspectorOpen: next });
  environmentStorage.setItem("citropy.inspector", next ? "1" : "0");
}

export function toggleSidebar(): void {
  const next = !useApp.getState().sidebarOpen;
  useApp.setState({ sidebarOpen: next });
  environmentStorage.setItem("citropy.sidebar", next ? "1" : "0");
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
  environmentStorage.setItem("citropy.uiScale", String(uiScale));
  document.documentElement.style.setProperty(
    "--ui-scale",
    String(uiScale / 100),
  );
}

export function setTextStreaming(value: boolean): void {
  useApp.setState({ textStreaming: value });
  environmentStorage.setItem("citropy.textStreaming", value ? "1" : "0");
}

export function setShowGitHubIdentity(value: boolean): void {
  useApp.setState({ showGitHubIdentity: value });
  environmentStorage.setItem("citropy.showGitHubIdentity", value ? "1" : "0");
}

export function setTypingAnimation(value: boolean): void {
  useApp.setState({ typingAnimation: value });
  environmentStorage.setItem("citropy.typingAnimation", value ? "1" : "0");
}

export function setUiSounds(value: boolean): void {
  useApp.setState({ uiSounds: value });
  environmentStorage.setItem("citropy.uiSounds", value ? "1" : "0");
}

export function setUiAlertSounds(value: boolean): void {
  useApp.setState({ uiAlertSounds: value });
  environmentStorage.setItem("citropy.uiAlertSounds", value ? "1" : "0");
}

export function setUiSoundVolume(value: number): void {
  if (!Number.isFinite(value)) return;
  const uiSoundVolume = Math.max(0, Math.min(100, Math.round(value)));
  useApp.setState({ uiSoundVolume });
  environmentStorage.setItem("citropy.uiSoundVolume", String(uiSoundVolume));
}

export function setTypingSpeed(value: number): void {
  if (!Number.isFinite(value)) return;
  const typingSpeed = Math.max(20, Math.min(300, Math.round(value)));
  useApp.setState({ typingSpeed });
  environmentStorage.setItem("citropy.typingSpeed", String(typingSpeed));
}

export function markTextPresented(id: string): void {
  if (!useApp.getState().reveals[id]) return;
  useApp.setState((state) => {
    const { [id]: presented, ...reveals } = state.reveals;
    return { reveals };
  });
}

export function scaled(value: number): number {
  return Math.round((value * useApp.getState().uiScale) / 100);
}

export function viewportWidth(): number {
  return window.innerWidth / (useApp.getState().uiScale / 100);
}
