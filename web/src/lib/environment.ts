import { useSyncExternalStore } from "react";
import type { EnvironmentState } from "../../../shared/environments.ts";
import type { Project } from "../../../shared/protocol.ts";

let initial: EnvironmentState = { activeId: "local", endpoint: "", connections: [] };
let controller = new AbortController();
let switching: string | null = null;
let selection = 0;
let pushes = 0;
const listeners = new Set<() => void>();
type WorkspaceCatalog = Record<string, { home: string; projects: Project[] }>;
let workspaces: WorkspaceCatalog = {};
try {
  const saved = typeof localStorage === "undefined" ? {} : JSON.parse(localStorage.getItem("citropy.workspaces") || "{}");
  for (const [id, value] of Object.entries(saved) as [string, WorkspaceCatalog[string]][]) {
    if (typeof value?.home === "string" && Array.isArray(value.projects))
      workspaces[id] = { home: value.home, projects: value.projects.filter(project => typeof project?.id === "string" && typeof project.name === "string" && typeof project.path === "string") };
  }
} catch {}

function publish(): void { for (const listener of listeners) listener(); }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export async function initializeEnvironment(): Promise<void> {
  if (window.citropyDesktop?.environmentsState) initial = await window.citropyDesktop.environmentsState();
  if (initial.activeId !== "local" && !/^http:\/\/127\.0\.0\.1:\d+$/.test(initial.endpoint))
    throw new Error("The SSH environment has no local tunnel endpoint.");
  const unsubscribe = window.citropyDesktop?.onEnvironmentsState?.(value => {
    pushes++;
    initial = { ...value, activeId: initial.activeId, endpoint: initial.endpoint };
    publish();
  });
  if (import.meta.hot) import.meta.hot.dispose(() => { unsubscribe?.(); controller.abort(); });
}

export function environmentId(): string { return initial.activeId; }
export function environmentSignal(): AbortSignal { return controller.signal; }
export function isRemote(): boolean { return initial.activeId !== "local"; }
export function environmentName(): string { return initial.connections.find(entry => entry.id === initial.activeId)?.name || "Local"; }
export function connectionName(id: string): string { return initial.connections.find(entry => entry.id === id)?.name || id; }
export function serverUrl(path: string): string { return `${initial.endpoint}${path}`; }

export function useEnvironments(): EnvironmentState {
  return useSyncExternalStore(subscribe, () => initial);
}

export function useWorkspaceCatalog(): WorkspaceCatalog {
  return useSyncExternalStore(subscribe, () => workspaces);
}

export function rememberWorkspaces(projects: Project[], home: string): void {
  workspaces = { ...workspaces, [initial.activeId]: { home, projects: projects.map(({ id, name, path, isGit, lastOpened }) => ({ id, name, path, isGit, lastOpened })) } };
  try { localStorage.setItem("citropy.workspaces", JSON.stringify(workspaces)); } catch {}
  publish();
}

export async function selectEnvironment(id: string, projectId?: string): Promise<void> {
  const desktop = window.citropyDesktop;
  if (!desktop?.connectEnvironment) throw new Error("Open Citropy desktop to use SSH environments.");
  if (switching && id !== "local") throw new Error("Wait for the current connection or cancel it first.");
  const turn = ++selection;
  const pushesBefore = pushes;
  switching = id;
  try {
    const snapshot = await desktop.connectEnvironment(id);
    if (turn !== selection) return;
    if (id !== "local" && !/^http:\/\/127\.0\.0\.1:\d+$/.test(snapshot.endpoint)) throw new Error("The SSH environment has no local tunnel endpoint.");
    const [{ connect, disconnect, waitUntilConnected }, { resetEnvironment, selectProject, useApp }] = await Promise.all([import("./socket.ts"), import("./store.ts")]);
    if (turn !== selection) return;
    const next = pushes === pushesBefore ? snapshot : { ...snapshot, connections: initial.connections };
    if (id !== initial.activeId) {
      disconnect(true);
      controller.abort();
      controller = new AbortController();
      initial = next;
      resetEnvironment(workspaces[id]?.projects ?? [], workspaces[id]?.home ?? "");
      publish();
      connect();
    } else {
      initial = next;
      publish();
      connect();
    }
    await waitUntilConnected(controller.signal);
    if (turn !== selection) return;
    if (projectId && useApp.getState().activeProjectId !== projectId) {
      if (!useApp.getState().projects.some(project => project.id === projectId)) throw new Error("This workspace is no longer open on that host.");
      selectProject(projectId);
    }
  } catch (error) {
    if (turn === selection) throw error;
  } finally {
    if (turn === selection) switching = null;
  }
}

function storageKey(key: string, id: string): string {
  return id !== "local" && (/^citropy\.(project|thread|offline)$/.test(key) || key.startsWith("citropy.draft."))
    ? `citropy.environment.${id}.${key}` : key;
}

export const environmentStorage = {
  getItem(key: string, id = initial.activeId): string | null { return localStorage.getItem(storageKey(key, id)); },
  setItem(key: string, value: string, id = initial.activeId): void { localStorage.setItem(storageKey(key, id), value); },
  removeItem(key: string, id = initial.activeId): void { localStorage.removeItem(storageKey(key, id)); },
};
