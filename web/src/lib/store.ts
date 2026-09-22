import { environmentStorage } from "./environment.ts";
import { resolveResponse } from "./requests.ts";
import { defaultAssistance } from "../../../shared/assistance.ts";
import type { Project, ServerEvent, ThreadMeta } from "../../../shared/protocol.ts";
import { useApp, readOffline, type AppState, type Confirmation } from "./app-state.ts";
import {
  replaceHistory,
  removeMessages,
  trimHistories,
  unloadedDelta,
  applyMessageEvent,
  historyChanges,
  type HistoryCollection,
} from "./history-cache.ts";
import { applyNotificationEvent, playAlert, restoreSnapshotNotifications } from "./notification-state.ts";

export { useApp } from "./app-state.ts";
export type { AppState, MessageShell, Toast, Confirmation, Theme, PanelId } from "./app-state.ts";
export {
  toggleFavoriteModel,
  setPanelWidth,
  setLanguage,
  setTheme,
  toggleInspector,
  toggleSidebar,
  setUiScale,
  setTextStreaming,
  setShowGitHubIdentity,
  setTypingAnimation,
  setUiSounds,
  setUiAlertSounds,
  setUiSoundVolume,
  setTypingSpeed,
  scaled,
  viewportWidth,
} from "./preferences.ts";

export function resetEnvironment(projects: Project[], home: string): void {
  useApp.getState().confirmation?.resolve(false);
  useApp.setState({
    shells: {},
    projectDefaults: {},
    assistance: { ...defaultAssistance },
    newThreadProvider: null,
    creatingThread: false,
    notifications: [],
    notificationPreferences: { toasts: true, desktop: true, sound: false, subagents: false },
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

export function applyEvents(
  previous: AppState,
  events: ServerEvent[],
): AppState {
  const state = { ...previous };
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
  trimHistories(state, previous);
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
      replaceHistory(state, event.threadId, event.messages);
      return;
    }
    case "thread.search":
      state.searchResult = event;
      return;
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
    trimHistories(next);
    return next;
  });
  if (id) environmentStorage.setItem("citropy.thread", id);
  else environmentStorage.removeItem("citropy.thread");
}

export function selectProject(id: string): void {
  useApp.setState((state) => {
    const next = { ...state, activeProjectId: id, activeThreadId: null };
    trimHistories(next);
    return next;
  });
  environmentStorage.removeItem("citropy.thread");
  environmentStorage.setItem("citropy.project", id);
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

export function markTextPresented(id: string): void {
  if (!useApp.getState().reveals[id]) return;
  useApp.setState((state) => {
    const { [id]: presented, ...reveals } = state.reveals;
    return { reveals };
  });
}
