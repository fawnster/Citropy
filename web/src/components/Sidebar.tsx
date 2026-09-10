import { SidebarFooter } from "./SidebarFooter.tsx";
import {
  GitBranch,
  Pin,
  Clock,
  GitPullRequest,
} from "lucide-react";
import { ConversationMenu } from "./ConversationMenu.tsx";
import { api, reportError } from "../lib/api.ts";
import { send } from "../lib/socket.ts";
import { useEffect, useMemo, useState } from "react";
import {
  MessageSquarePlus,
  Trash2,
  Search,
  Folder,
  ChevronRight,
  ChevronDown,
  FolderOpen,
  Plus,
  X,
  Check,
  RotateCcw,
} from "./icons.ts";
import { ThreadChildren } from "./ThreadChildren.tsx";
import type { ThreadMeta } from "../../../shared/protocol.ts";
import { ThreadPulse } from "./ThreadPulse.tsx";
import { ResizeHandle } from "./ResizeHandle.tsx";
import { ProviderIcon } from "./ProviderIcon.tsx";
import { Menu } from "./Menu.tsx";
import {
  chooseWorkspace,
  closeProject,
  createThread,
  loadThread,
  removeThread,
  finishThread,
} from "../lib/actions.ts";
import { selectProject, selectThread, useApp } from "../lib/store.ts";
import { modelLabel, providerLabels, shortPath } from "../lib/format.ts";

export function Sidebar({
  onSettings,
  onGit,
  onGitHub,
  onConversation,
  onUsage,
}: {
  onSettings: () => void;
  onGit: () => void;
  onGitHub: () => void;
  onConversation: () => void;
  onUsage: () => void;
}) {
  const threadMap = useApp((state) => state.threads);
  const order = useApp((state) => state.threadOrder);
  const activeProjectId = useApp((state) => state.activeProjectId);
  const activeThreadId = useApp((state) => state.activeThreadId);
  const providers = useApp((state) => state.providers);
  const projects = useApp((state) => state.projects);
  const home = useApp((state) => state.home);
  const choosingWorkspace = useApp((state) => state.choosingWorkspace);
  const project = projects.find((entry) => entry.id === activeProjectId);
  const [finishedOpen, setFinishedOpen] = useState(false);
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [dragging, setDragging] = useState<string>();
  let activeRoot = activeThreadId ? threadMap[activeThreadId] : undefined;
  while (activeRoot?.parentThreadId)
    activeRoot = threadMap[activeRoot.parentThreadId];
  const activeFinished = Boolean(activeRoot?.finished);
  useEffect(() => {
    if (activeFinished) setFinishedOpen(true);
  }, [activeThreadId, activeFinished]);
  const connected = useApp((state) => state.connected);
  const searchResult = useApp((state) => state.searchResult);
  const [allProjects, setAllProjects] = useState(false);
  const [query, setQuery] = useState("");
  const searchProject = allProjects
    ? undefined
    : (activeProjectId ?? undefined);
  useEffect(() => {
    if (!query.trim() || !connected) return;
    const timer = setTimeout(
      () => send({ t: "thread.search", query, projectId: searchProject }),
      200,
    );
    return () => clearTimeout(timer);
  }, [query, searchProject, connected]);
  const matches =
    searchResult?.query === query && searchResult.projectId === searchProject
      ? searchResult.results
      : undefined;
  const threads = useMemo(
    () =>
      (query.trim() ? (matches?.map((result) => result.threadId) ?? []) : order)
        .map((id) => threadMap[id])
        .filter((thread): thread is NonNullable<typeof thread> =>
          Boolean(
            thread && (query.trim() || thread.projectId === activeProjectId),
          ),
        ),
    [order, threadMap, activeProjectId, query, matches],
  );

  const roots = threads.filter(
    (thread) => !thread.parentThreadId || Boolean(query),
  );
  const sortThreads = (a: ThreadMeta, b: ThreadMeta) =>
    (a.position ?? Number.MAX_SAFE_INTEGER) -
      (b.position ?? Number.MAX_SAFE_INTEGER) || b.updatedAt - a.updatedAt;
  const archived = roots.filter((thread) => thread.archived).sort(sortThreads);
  const snoozed = roots
    .filter((thread) => !thread.archived && thread.snoozedUntil)
    .sort(sortThreads);
  const awake = roots.filter(
    (thread) => !thread.archived && !thread.snoozedUntil,
  );
  const finished = awake.filter((thread) => thread.finished).sort(sortThreads);
  const current = awake
    .filter((thread) => !thread.finished)
    .sort(
      (a, b) =>
        Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
        sortThreads(a, b),
    );
  const reorder = async (source: string, target: string) => {
    if (source === target || query || !activeProjectId) return;
    const ordered = [...current, ...finished, ...snoozed, ...archived].map(
      (thread) => thread.id,
    );
    const from = ordered.indexOf(source),
      to = ordered.indexOf(target);
    if (from < 0 || to < 0) return;
    ordered.splice(from, 1);
    ordered.splice(to, 0, source);
    try {
      await api(`threads/reorder?projectId=${activeProjectId}`, {
        method: "POST",
        body: JSON.stringify({ ids: ordered }),
      });
    } catch (error) {
      reportError(error);
    }
  };
  const childrenByParent = useMemo(() => {
    const groups = new Map<string, ThreadMeta[]>();
    for (const thread of Object.values(threadMap)) {
      if (!thread.parentThreadId) continue;
      const group = groups.get(thread.parentThreadId) ?? [];
      group.push(thread);
      groups.set(thread.parentThreadId, group);
    }
    for (const group of groups.values())
      group.sort((a, b) => a.createdAt - b.createdAt);
    return groups;
  }, [threadMap]);
  const selectedPath = useMemo(() => {
    const path = new Set<string>();
    let thread = activeThreadId ? threadMap[activeThreadId] : undefined;
    while (thread && !path.has(thread.id)) {
      path.add(thread.id);
      thread = thread.parentThreadId
        ? threadMap[thread.parentThreadId]
        : undefined;
    }
    return path;
  }, [threadMap, activeThreadId]);
  const activePaths = useMemo(() => {
    const paths = new Set<string>();
    for (const entry of Object.values(threadMap)) {
      if (!entry.running && ["idle", "stopped"].includes(entry.status))
        continue;
      let thread: ThreadMeta | undefined = entry;
      while (thread && !paths.has(thread.id)) {
        paths.add(thread.id);
        thread = thread.parentThreadId
          ? threadMap[thread.parentThreadId]
          : undefined;
      }
    }
    return paths;
  }, [threadMap]);
  const renderThread = (thread: (typeof threads)[number]) => {
    const provider = providers.find((entry) => entry.id === thread.provider);
    const name = modelLabel(provider?.models ?? [], thread.model);
    const providerName = provider?.label ?? providerLabels[thread.provider];
    return (
      <div
        className="thread-entry"
        key={thread.id}
        draggable={!query}
        data-dragging={dragging === thread.id}
        onDragStart={(event) => {
          setDragging(thread.id);
          event.dataTransfer.setData("text/citropy-thread", thread.id);
          event.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => setDragging(undefined)}
        onDragOver={(event) => {
          if (dragging) event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (dragging) void reorder(dragging, thread.id);
          setDragging(undefined);
        }}
      >
        <button
          type="button"
          className="thread-row"
          data-active={thread.id === activeThreadId}
          title={thread.title}
          onClick={() => {
            onConversation();
            if (thread.projectId !== activeProjectId)
              selectProject(thread.projectId);
            selectThread(thread.id);
            loadThread(thread.id);
            useApp.setState({
              searchMessageId:
                matches?.find((result) => result.threadId === thread.id)
                  ?.messageId ?? null,
            });
          }}
        >
          <span className="thread-row-body">
            <span
              className="thread-provider"
              title={`${providerName} · ${name}`}
            >
              <ProviderIcon provider={thread.provider} />
              <span>{providerName}</span>
              <span aria-hidden="true">·</span>
              <span className="truncate">{name}</span>
            </span>
            <span className="thread-row-title truncate">{thread.title}</span>
            {query.trim() && allProjects && (
              <span className="thread-row-meta">
                <Folder size={12} />
                {projects.find((entry) => entry.id === thread.projectId)?.name}
              </span>
            )}
            <span className="thread-row-meta">
              {thread.pinned && <Pin size={12} aria-label="Pinned" />}
              <time
                dateTime={new Date(thread.updatedAt).toISOString()}
                title={new Date(thread.updatedAt).toLocaleString()}
              >
                {new Date(thread.updatedAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}{" "}
                ·{" "}
                {new Date(thread.updatedAt).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
              {Boolean(thread.changedFiles) && (
                <span>
                  {thread.changedFiles}{" "}
                  {thread.changedFiles === 1 ? "file" : "files"}
                </span>
              )}
              {thread.status !== "idle" && (
                <span className="thread-status" title={thread.status}>
                  <ThreadPulse status={thread.status} />
                  {thread.status === "error"
                    ? "Failed"
                    : thread.status === "awaiting"
                      ? "Approval"
                      : thread.status.charAt(0).toUpperCase() +
                        thread.status.slice(1)}
                </span>
              )}
            </span>
            {thread.workspaceBranch && (
              <span className="thread-row-meta">
                <GitBranch size={12} />
                {thread.workspaceBranch}
              </span>
            )}
            {thread.snoozedUntil && (
              <span className="thread-row-meta">
                <Clock size={12} />
                Until{" "}
                {new Date(thread.snoozedUntil).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            )}
            {query.trim() && (
              <span className="search-snippet">
                {
                  matches?.find((result) => result.threadId === thread.id)
                    ?.snippet
                }
              </span>
            )}
          </span>
        </button>
        <div className="thread-row-actions">
          <ConversationMenu
            thread={thread}
            onMove={(direction) => {
              const group = thread.archived
                ? archived
                : thread.snoozedUntil
                  ? snoozed
                  : thread.finished
                    ? finished
                    : current;
              const next =
                group[
                  group.findIndex((entry) => entry.id === thread.id) + direction
                ];
              if (next) void reorder(thread.id, next.id);
            }}
          />
          <button
            className="thread-row-finish"
            type="button"
            title={
              thread.running || thread.status === "awaiting"
                ? "Stop this conversation before finishing"
                : `${thread.finished ? "Reopen" : "Finish"} ${thread.title}`
            }
            aria-label={`${thread.finished ? "Reopen" : "Finish"} ${thread.title}`}
            disabled={
              !connected ||
              thread.running ||
              thread.status === "awaiting" ||
              Object.values(threadMap).some(
                (child) => child.parentThreadId === thread.id && child.running,
              )
            }
            onClick={() => {
              finishThread(thread.id, !thread.finished);
              if (!thread.finished) setFinishedOpen(true);
            }}
          >
            {thread.finished ? <RotateCcw size={14} /> : <Check size={15} />}
          </button>
          <button
            className="thread-row-kill"
            type="button"
            title={`Delete ${thread.title}`}
            onClick={() => removeThread(thread.id)}
          >
            <Trash2 size={13} />
          </button>
        </div>
        {thread.pullRequest && (
          <a
            className="thread-pr"
            href={thread.pullRequest}
            target="_blank"
            rel="noreferrer"
          >
            <GitPullRequest size={12} />
            Pull request #{thread.pullRequest.split("/").at(-1)}
          </a>
        )}
        {!query && (
          <ThreadChildren
            parent={thread}
            childrenByParent={childrenByParent}
            selectedPath={selectedPath}
            activePaths={activePaths}
            activeThreadId={activeThreadId}
            onConversation={onConversation}
          />
        )}
      </div>
    );
  };

  return (
    <aside className="rail" aria-label="Conversations">
      <div className="rail-head">
        <Menu
          align="start"
          header="Workspaces"
          width={320}
          searchable
          searchPlaceholder="Find a workspace"
          items={[
            ...projects.map((entry) => ({
              id: entry.id,
              label: entry.name,
              hint: shortPath(entry.path, home),
              selected: entry.id === activeProjectId,
              icon: <FolderOpen size={16} />,
              onSelect: () => {
                if (entry.id !== activeProjectId) selectProject(entry.id);
                setQuery("");
              },
            })),
            {
              id: "open",
              label: "Open folder…",
              icon: <Plus size={16} />,
              onSelect: chooseWorkspace,
            },
            ...(project
              ? [
                  {
                    id: "close",
                    label: `Close ${project.name}`,
                    icon: <X size={16} />,
                    danger: true,
                    onSelect: () => closeProject(project.id),
                  },
                ]
              : []),
          ]}
          trigger={({ toggle, id, open }) => (
            <button
              id={id}
              type="button"
              className="workspace-select"
              aria-label={`Choose workspace, ${project?.name ?? "none selected"}`}
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={toggle}
              disabled={choosingWorkspace}
              title={project?.path}
            >
              <FolderOpen size={18} />
              <span className="truncate">
                {choosingWorkspace
                  ? "Choosing folder…"
                  : (project?.name ?? "Open a workspace")}
              </span>
              <ChevronDown size={14} />
            </button>
          )}
        />
        <Menu
          align="start"
          header="Choose a provider"
          width={240}
          items={providers
            .filter((provider) => provider.available && provider.enabled)
            .map((provider) => ({
              id: provider.id,
              label: provider.label,
              icon: <ProviderIcon provider={provider.id} />,
              onSelect: () => {
                onConversation();
                createThread(provider.id);
              },
            }))}
          trigger={({ toggle, id, open }) => (
            <button
              id={id}
              aria-haspopup="menu"
              aria-expanded={open}
              className="new-thread"
              type="button"
              onClick={toggle}
              disabled={!activeProjectId}
            >
              <MessageSquarePlus size={17} /> New thread
            </button>
          )}
        />
      </div>
      <label className="thread-search">
        <Search size={14} aria-hidden="true" />
        <input
          aria-label="Find a conversation"
          placeholder="Search conversations"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {query.trim() && (
        <label className="search-scope">
          <input
            type="checkbox"
            checked={allProjects}
            onChange={(event) => setAllProjects(event.target.checked)}
          />
          All workspaces
        </label>
      )}
      <div className="rail-list scroll">
        {current.map(renderThread)}
        {snoozed.length > 0 && (
          <>
            <button
              className="finished-toggle"
              type="button"
              aria-expanded={snoozedOpen || Boolean(query)}
              onClick={() => setSnoozedOpen((open) => !open)}
            >
              <ChevronRight size={13} />
              <span>Snoozed</span>
              <span>{snoozed.length}</span>
            </button>
            {(snoozedOpen || query) && snoozed.map(renderThread)}
          </>
        )}
        {archived.length > 0 && (
          <>
            <button
              className="finished-toggle"
              type="button"
              aria-expanded={archivedOpen || Boolean(query)}
              onClick={() => setArchivedOpen((open) => !open)}
            >
              <ChevronRight size={13} />
              <span>Archived</span>
              <span>{archived.length}</span>
            </button>
            {(archivedOpen || query) && archived.map(renderThread)}
          </>
        )}
        {finished.length > 0 && (
          <>
            <button
              className="finished-toggle"
              type="button"
              aria-expanded={finishedOpen || Boolean(query)}
              onClick={() => setFinishedOpen((open) => !open)}
            >
              <ChevronRight size={13} />
              <span>Finished</span>
              <span>{finished.length}</span>
            </button>
            {(finishedOpen || Boolean(query)) && finished.map(renderThread)}
          </>
        )}
        {threads.length === 0 && (
          <div className="rail-empty">
            {query
              ? !connected
                ? "Reconnect to search conversations."
                : !matches
                  ? "Searching…"
                  : "No matching conversations."
              : "Your conversations will appear here."}
          </div>
        )}
      </div>
      <SidebarFooter
        onGit={onGit}
        onGitHub={onGitHub}
        onSettings={onSettings}
        onUsage={onUsage}
      />
      <ResizeHandle panel="sidebar" />
    </aside>
  );
}
