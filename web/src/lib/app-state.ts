import type { QuestionRequest } from "../../../shared/questions.ts";
import { environmentStorage } from "./environment.ts";
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

export function readOffline(): Record<string, QueuedMessage[]> {
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
  notificationPreferences: { toasts: true, desktop: true, sound: false, subagents: false },
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
