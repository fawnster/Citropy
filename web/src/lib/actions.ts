import type {
  GitHubRequests,
  GitHubResponses,
  GitHubRequest,
} from "../../../shared/github.ts";
import { selectThread, selectPanel, useApp, confirmAction } from "./store.ts";
import { awaitResponse } from "./requests.ts";
import { requestId, send } from "./socket.ts";
import { flushHeld, holdMessage } from "./offline.ts";
import type {
  FileEntry,
  FilePatch,
  GitResult,
  PermissionMode,
  ProviderId,
} from "../../../shared/protocol.ts";
import type { PanelKind } from "../../../shared/workbench.ts";

export function openWorkbenchPanel(kind: PanelKind): void {
  const state = useApp.getState();
  if (!state.activeProjectId || !state.connected) return;
  const existing =
    !["browser", "terminal"].includes(kind) &&
    state.panels.find(
      (panel) =>
        panel.projectId === state.activeProjectId && panel.kind === kind,
    );
  if (existing) {
    selectPanel(existing.id);
    return;
  }
  const id = crypto.randomUUID();
  useApp.setState({
    inspectorOpen: true,
    activePanels: { ...state.activePanels, [state.activeProjectId]: id },
  });
  send({
    t: "panel.open",
    id,
    projectId: state.activeProjectId,
    kind,
    threadId: state.activeThreadId ?? undefined,
  });
}

export function openProject(path: string): void {
  send({ t: "project.open", path });
}

export function closeProject(id: string): void {
  send({ t: "project.close", id });
}

export function createThread(provider?: ProviderId): void {
  const state = useApp.getState();
  const projectId = state.activeProjectId;
  if (!projectId) return;
  const available = state.providers.filter(
    (entry) => entry.available && entry.enabled,
  );
  const previous = state.activeThreadId
    ? state.threads[state.activeThreadId]
    : undefined;
  const chosen =
    provider ??
    available.find(
      (entry) =>
        entry.id ===
        state.projects.find((project) => project.id === projectId)?.settings
          ?.provider,
    )?.id ??
    available.find((entry) => entry.id === previous?.provider)?.id ??
    available[0]?.id;
  if (!chosen || !available.some((entry) => entry.id === chosen)) {
    useApp.setState((state) => ({
      toasts: [
        ...state.toasts,
        {
          id: `provider-${Date.now()}`,
          level: "info",
          text: "Enable an installed provider in Settings > Providers to start a conversation.",
        },
      ],
    }));
    return;
  }
  useApp.setState({ newThreadProvider: chosen });
}

export function loadThread(id: string): void {
  if (useApp.getState().loaded[id]) return;
  send({ t: "thread.load", id });
}

export async function sendMessage(
  text: string,
  attachments: import("../../../shared/protocol.ts").Attachment[] = [],
): Promise<void> {
  const threadId = useApp.getState().activeThreadId;
  if (!threadId || (!text.trim() && !attachments.length)) return;
  useApp.setState((state) => ({ followRequest: state.followRequest + 1 }));
  const state = useApp.getState();
  if (!state.connected || state.offline[threadId]?.length) {
    holdMessage(threadId, text, attachments);
    void flushHeld();
  } else {
    const id = requestId();
    const accepted = awaitResponse(id);
    send({ t: "thread.send", threadId, text, attachments, requestId: id });
    await accepted;
  }
  localStorage.removeItem(`citropy.draft.${threadId}`);
}

export async function editQueued(threadId: string, id: string): Promise<void> {
  const request = requestId();
  const accepted = awaitResponse(request);
  send({ t: "queue.edit", threadId, id, requestId: request });
  await accepted;
}

export function stopThread(): void {
  const threadId = useApp.getState().activeThreadId;
  if (!threadId) return;
  send({ t: "thread.stop", threadId });
}

export async function removeThread(id: string): Promise<void> {
  const thread = useApp.getState().threads[id];
  if (!thread || !useApp.getState().connected) return;
  const confirmed = await confirmAction({
    title: "Delete this conversation?",
    context: thread.title,
    description:
      "This permanently deletes the conversation and its subagents. Files in your workspace stay on disk.",
    label: "Delete conversation",
    danger: true,
  });
  if (confirmed && useApp.getState().connected)
    send({ t: "thread.remove", id });
}

export function finishThread(id: string, finished: boolean): void {
  send({ t: "thread.finish", id, finished });
}

export function configureThread(
  id: string,
  patch: {
    model?: string;
    effort?: string | null;
    contextWindow?: number;
    fastMode?: boolean;
    permissionMode?: PermissionMode;
    title?: string;
  },
): void {
  send({ t: "thread.config", id, ...patch });
}

export function answerPermission(
  id: string,
  decision: "allow" | "allow_always" | "deny",
): void {
  send({ t: "permission.answer", id, decision });
}

export function refreshGit(projectId: string): void {
  send({ t: "git.refresh", projectId });
}

export function fetchDiff(
  projectId: string,
  path: string,
  staged: boolean,
): Promise<FilePatch | null> {
  const id = requestId();
  const promise = awaitResponse<FilePatch | null>(id);
  send({ t: "git.diff", requestId: id, projectId, path, staged });
  return promise;
}

export function stageFile(
  projectId: string,
  path: string,
  staged: boolean,
): void {
  send({ t: "git.stage", projectId, path, staged });
}

export function discardFile(projectId: string, path: string): void {
  send({ t: "git.discard", projectId, path });
}

export function commitAll(projectId: string, message: string): void {
  send({ t: "git.commit", projectId, message });
}

export function fetchTree(
  projectId: string,
  path?: string,
): Promise<FileEntry[]> {
  const id = requestId();
  const promise = awaitResponse<FileEntry[]>(id, 30_000);
  send({ t: "file.tree", requestId: id, projectId, path });
  return promise;
}

export function fetchFile(
  projectId: string,
  path: string,
): Promise<string | null> {
  const id = requestId();
  const promise = awaitResponse<string | null>(id, 30_000);
  send({ t: "file.read", requestId: id, projectId, path });
  return promise;
}

export function chooseWorkspace(): void {
  if (useApp.getState().choosingWorkspace) return;
  useApp.setState({ choosingWorkspace: true });
  send({ t: "project.choose" });
}

export function manageGit(
  projectId: string,
  operation: import("../../../shared/protocol.ts").GitOperation,
  value?: string,
  offset?: number,
  remote?: string,
) {
  const id = requestId();
  const promise = awaitResponse<GitResult>(id);
  send({
    t: "git.manage",
    requestId: id,
    projectId,
    operation,
    value,
    offset,
    remote,
  });
  return promise;
}

export function github<K extends keyof GitHubRequests>(
  operation: K,
  input: GitHubRequests[K],
): Promise<GitHubResponses[K]> {
  if (!useApp.getState().connected)
    return Promise.reject(new Error("Reconnect to Citropy to use GitHub."));
  const id = requestId();
  const promise = awaitResponse<GitHubResponses[K]>(id, 600_000);
  send({
    t: "github.request",
    requestId: id,
    request: { operation, ...input } as GitHubRequest,
  });
  return promise as Promise<GitHubResponses[K]>;
}
