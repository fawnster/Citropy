import { SidebarFooter } from "./SidebarFooter.tsx";
import {
  GitBranch,
  Pin,
  Clock,
  GitPullRequest,
  CircleCheck,
  Archive,
  MessagesSquare,
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
  Check,
  RotateCcw,
} from "./icons.ts";
import { ThreadChildren } from "./ThreadChildren.tsx";
import type { ThreadMeta } from "../../../shared/protocol.ts";
import { ThreadPulse } from "./ThreadPulse.tsx";
import { ResizeHandle } from "./ResizeHandle.tsx";
import { ProviderIcon } from "./ProviderIcon.tsx";
import { WorkspaceSelector } from "./WorkspaceSelector.tsx";
import {
  createThread,
  loadThread,
  removeThread,
  finishThread,
} from "../lib/actions.ts";
import { selectProject, selectThread, useApp } from "../lib/store.ts";
import { modelLabel, providerLabels } from "../lib/format.ts";
import { currentLocale, useI18n } from "../lib/i18n.ts";

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
  const t = useI18n();
  const threadMap = useApp((state) => state.threads);
  const order = useApp((state) => state.threadOrder);
  const activeProjectId = useApp((state) => state.activeProjectId);
  const activeThreadId = useApp((state) => state.activeThreadId);
  const providers = useApp((state) => state.providers);
  const projects = useApp((state) => state.projects);
  const [finishedOpen, setFinishedOpen] = useState(false);
  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [currentOpen, setCurrentOpen] = useState(true);
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [dragging, setDragging] = useState<string>();
  let activeRoot = activeThreadId ? threadMap[activeThreadId] : undefined;
  while (activeRoot?.parentThreadId)
    activeRoot = threadMap[activeRoot.parentThreadId];
  const activeFinished = Boolean(activeRoot?.finished);
  const activePinned = Boolean(activeRoot?.pinned && !activeRoot.finished);
  const activeCurrent = Boolean(activeRoot && !activeRoot.finished && !activeRoot.pinned && !activeRoot.archived && !activeRoot.snoozedUntil);
  useEffect(() => {
    if (activeFinished) setFinishedOpen(true);
  }, [activeThreadId, activeFinished]);
  useEffect(() => {
    if (activePinned) setPinnedOpen(true);
  }, [activeThreadId, activePinned]);
  useEffect(() => {
    if (activeCurrent) setCurrentOpen(true);
  }, [activeThreadId, activeCurrent]);
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
  const pinned = awake.filter((thread) => !thread.finished && thread.pinned).sort(sortThreads);
  const current = awake.filter((thread) => !thread.finished && !thread.pinned).sort(sortThreads);
  const reorder = async (source: string, target: string) => {
    if (source === target || query || !activeProjectId) return;
    const ordered = [...pinned, ...current, ...finished, ...snoozed, ...archived].map(
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
        <div className="thread-card" data-active={thread.id === activeThreadId}>
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
              {(thread.pinned ||
                thread.changedFiles ||
                thread.status !== "idle") && (
                <span className="thread-row-meta">
                  {thread.pinned && <Pin size={12} aria-label={t("Pinned")} />}
                  {Boolean(thread.changedFiles) && (
                    <span>
                      {thread.changedFiles}{" "}
                      {thread.changedFiles === 1 ? t("file") : t("files")}
                    </span>
                  )}
                  {thread.status !== "idle" && (
                    <span className="thread-status" title={thread.status}>
                      <ThreadPulse status={thread.status} />
                      {thread.status === "error"
                        ? t("Failed")
                        : thread.status === "awaiting"
                          ? t("Approval")
                          : t(thread.status)}
                    </span>
                  )}
                </span>
              )}
              {thread.workspaceBranch && (
                <span className="thread-row-meta">
                  <GitBranch size={12} />
                  {thread.workspaceBranch}
                </span>
              )}
              {thread.snoozedUntil && (
                <span className="thread-row-meta">
                  <Clock size={12} />
                  {t("Until")} {" "}
                  {new Date(thread.snoozedUntil).toLocaleString(currentLocale(), {
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
          <div className="thread-row-footer">
            <time
              dateTime={new Date(thread.updatedAt).toISOString()}
              title={new Date(thread.updatedAt).toLocaleString(currentLocale())}
            >
              {new Date(thread.updatedAt).toLocaleDateString(currentLocale(), {
                month: "short",
                day: "numeric",
              })}{" "}
              ·{" "}
              {new Date(thread.updatedAt).toLocaleTimeString(currentLocale(), {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
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
                        : thread.pinned ? pinned : current;
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
                    ? t("Stop this conversation before finishing")
                    : `${thread.finished ? t("Reopen") : t("Finish")} ${thread.title}`
                }
                aria-label={`${thread.finished ? t("Reopen") : t("Finish")} ${thread.title}`}
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
                title={`${t("Delete")} ${thread.title}`}
                onClick={() => removeThread(thread.id)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        </div>
        {thread.pullRequest && (
          <a
            className="thread-pr"
            href={thread.pullRequest}
            target="_blank"
            rel="noreferrer"
          >
            <GitPullRequest size={12} />
            {t("Pull request")} #{thread.pullRequest.split("/").at(-1)}
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
    <aside className="rail" aria-label={t("Conversations")}>
      <div className="rail-head">
        <WorkspaceSelector onSelect={() => setQuery("")} />
      </div>
      <div className="thread-toolbar">
        <label className="thread-search">
          <Search size={14} aria-hidden="true" />
          <input
            aria-label={t("Find a conversation")}
            placeholder={t("Search conversations")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          className="new-thread"
          aria-label={t("New thread")}
          title={t("New thread")}
          type="button"
          onClick={() => { onConversation(); createThread(); }}
          disabled={!activeProjectId || !providers.some((provider) => provider.available && provider.enabled)}
        >
          <MessageSquarePlus size={18} />
        </button>
      </div>
      {query.trim() && (
        <label className="search-scope">
          <input
            type="checkbox"
            checked={allProjects}
            onChange={(event) => setAllProjects(event.target.checked)}
          />
          {t("All workspaces")}
        </label>
      )}
      <div className="rail-list scroll">
        {pinned.length > 0 && (
          <section className="thread-category" data-category="pinned">
            <button className="finished-toggle" type="button" aria-expanded={pinnedOpen || Boolean(query)} onClick={() => setPinnedOpen((open) => !open)}>
              <ChevronRight size={12} className="category-chevron" />
              <Pin size={14} className="category-icon" />
              <span>{t("Pinned")}</span><span>{pinned.length}</span>
            </button>
            {(pinnedOpen || query) && pinned.map(renderThread)}
          </section>
        )}
        {current.length > 0 && (
          <section className="thread-category" data-category="active">
            <button className="finished-toggle" type="button" aria-expanded={currentOpen || Boolean(query)} onClick={() => setCurrentOpen((open) => !open)}>
              <ChevronRight size={12} className="category-chevron" />
              <MessagesSquare size={14} className="category-icon" />
              <span>{t("Active", undefined, "conversations")}</span><span>{current.length}</span>
            </button>
            {(currentOpen || query) && current.map(renderThread)}
          </section>
        )}
        {snoozed.length > 0 && (
          <section className="thread-category" data-category="snoozed">
            <button
              className="finished-toggle"
              type="button"
              aria-expanded={snoozedOpen || Boolean(query)}
              onClick={() => setSnoozedOpen((open) => !open)}
            >
              <ChevronRight size={12} className="category-chevron" />
              <Clock size={14} className="category-icon" />
              <span>{t("Snoozed")}</span>
              <span>{snoozed.length}</span>
            </button>
            {(snoozedOpen || query) && snoozed.map(renderThread)}
          </section>
        )}
        {archived.length > 0 && (
          <section className="thread-category" data-category="archived">
            <button
              className="finished-toggle"
              type="button"
              aria-expanded={archivedOpen || Boolean(query)}
              onClick={() => setArchivedOpen((open) => !open)}
            >
              <ChevronRight size={12} className="category-chevron" />
              <Archive size={14} className="category-icon" />
              <span>{t("Archived", undefined, "conversations")}</span>
              <span>{archived.length}</span>
            </button>
            {(archivedOpen || query) && archived.map(renderThread)}
          </section>
        )}
        {finished.length > 0 && (
          <section className="thread-category" data-category="finished">
            <button
              className="finished-toggle"
              type="button"
              aria-expanded={finishedOpen || Boolean(query)}
              onClick={() => setFinishedOpen((open) => !open)}
            >
              <ChevronRight size={12} className="category-chevron" />
              <CircleCheck size={14} className="category-icon category-finished" />
              <span>{t("Finished")}</span>
              <span>{finished.length}</span>
            </button>
            {(finishedOpen || Boolean(query)) && finished.map(renderThread)}
          </section>
        )}
        {threads.length === 0 && (
          <div className="rail-empty">
            {query
              ? !connected
                ? t("Reconnect to search conversations.")
                : !matches
                  ? t("Searching…")
                  : t("No matching conversations.")
              : t("Your conversations will appear here.")}
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
