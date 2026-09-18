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
import { Collapsible } from "./Collapsible.tsx";
import { api, reportError } from "../lib/api.ts";
import { send } from "../lib/socket.ts";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
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
import { ThreadPreview } from "./ThreadPreview.tsx";
import { ResizeHandle } from "./ResizeHandle.tsx";
import { ProviderIcon } from "./ProviderIcon.tsx";
import {
  createThread,
  loadThread,
  removeThread,
  finishThread,
} from "../lib/actions.ts";
import { scaled, selectProject, selectThread, useApp } from "../lib/store.ts";
import { modelLabel, threadActivity } from "../lib/format.ts";
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
  const [dropTarget, setDropTarget] = useState<{ id: string; edge: "before" | "after" }>();
  const dragCleanup = useRef<() => void>(() => {});
  const dragHeight = useRef(0);
  const suppressClick = useRef(false);
  const uiScale = useApp((state) => state.uiScale);
  const [preview, setPreview] = useState<{ threadId: string; anchor: HTMLButtonElement }>();
  const previewId = useId();
  const previewTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const clearPreviewTimer = useCallback(() => {
    clearTimeout(previewTimer.current);
    previewTimer.current = undefined;
  }, []);
  const hidePreview = useCallback(() => {
    clearPreviewTimer();
    setPreview(undefined);
  }, [clearPreviewTimer]);
  const leavePreview = () => {
    clearPreviewTimer();
    previewTimer.current = setTimeout(hidePreview, 120);
  };
  const showPreview = (anchor: HTMLButtonElement, threadId: string, immediate = false) => {
    clearPreviewTimer();
    if (preview?.threadId === threadId || dragging) return;
    setPreview(undefined);
    previewTimer.current = setTimeout(() => {
      previewTimer.current = undefined;
      if (anchor.isConnected && (anchor.matches(":hover") || anchor.matches(":focus-visible"))) setPreview({ threadId, anchor });
    }, immediate ? 0 : 500);
  };
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
  const creatingThread = useApp((state) => state.creatingThread);
  const searchResult = useApp((state) => state.searchResult);
  const [allProjects, setAllProjects] = useState(false);
  const [query, setQuery] = useState("");
  useEffect(() => setQuery(""), [activeProjectId]);
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

  const { archived, snoozed, finished, pinned, current } = useMemo(() => {
    const roots = threads.filter((thread) => !thread.parentThreadId || Boolean(query));
    const sortThreads = (a: ThreadMeta, b: ThreadMeta) =>
      (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) || b.updatedAt - a.updatedAt;
    const archived = roots.filter((thread) => thread.archived).sort(sortThreads);
    const snoozed = roots.filter((thread) => !thread.archived && thread.snoozedUntil).sort(sortThreads);
    const awake = roots.filter((thread) => !thread.archived && !thread.snoozedUntil);
    return {
      archived,
      snoozed,
      finished: awake.filter((thread) => thread.finished).sort(sortThreads),
      pinned: awake.filter((thread) => !thread.finished && thread.pinned).sort(sortThreads),
      current: awake.filter((thread) => !thread.finished && !thread.pinned).sort(sortThreads),
    };
  }, [threads, query]);
  const groups = useMemo(() => [
    { id: "pinned", label: "Pinned", icon: Pin, threads: pinned, open: pinnedOpen, toggle: () => setPinnedOpen((open) => !open) },
    { id: "active", label: "Active", icon: MessagesSquare, threads: current, open: currentOpen, toggle: () => setCurrentOpen((open) => !open) },
    { id: "snoozed", label: "Snoozed", icon: Clock, threads: snoozed, open: snoozedOpen, toggle: () => setSnoozedOpen((open) => !open) },
    { id: "archived", label: "Archived", icon: Archive, threads: archived, open: archivedOpen, toggle: () => setArchivedOpen((open) => !open) },
    { id: "finished", label: "Finished", icon: CircleCheck, threads: finished, open: finishedOpen, toggle: () => setFinishedOpen((open) => !open) },
  ].filter((group) => group.threads.length > 0), [pinned, current, snoozed, archived, finished, pinnedOpen, currentOpen, snoozedOpen, archivedOpen, finishedOpen]);
  const rows = useMemo(() => groups.flatMap((group) => [
    { key: group.id, group, thread: undefined as ThreadMeta | undefined },
    ...(group.open || query ? group.threads.map((thread) => ({ key: thread.id, group, thread })) : []),
  ]), [groups, query]);
  const rowOrder = rows.map(row => row.key).join("\0");
  useEffect(() => {
    hidePreview();
    return clearPreviewTimer;
  }, [activeProjectId, activeThreadId, query, rowOrder, uiScale, hidePreview, clearPreviewTimer]);
  useEffect(() => () => dragCleanup.current(), [activeProjectId, query, connected, uiScale, rowOrder]);
  const viewport = useRef<HTMLDivElement>(null);
  const [focusedRow, setFocusedRow] = useState<string>();
  const virtualized = rows.length > 40;
  const focusedIndex = rows.findIndex((row) => row.key === focusedRow);
  const draggingIndex = rows.findIndex((row) => row.key === dragging);
  const getItemKey = useCallback((index: number) => rows[index]!.key, [rows]);
  const list = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    enabled: virtualized,
    getScrollElement: () => viewport.current,
    getItemKey,
    estimateSize: (index) => scaled(rows[index]?.thread ? 96 : 40),
    measureElement: (element) => element.offsetHeight,
    overscan: 3,
    rangeExtractor: useCallback((range: Range) => [...new Set([
      ...defaultRangeExtractor(range),
      ...[focusedIndex, draggingIndex].filter((index) => index >= 0),
    ])].sort((a, b) => a - b), [focusedIndex, draggingIndex]),
  });
  useEffect(() => {
    if (!virtualized) return;
    const index = rows.findIndex((row) => row.thread?.id === activeRoot?.id);
    if (index >= 0) list.scrollToIndex(index, { align: "auto" });
  }, [activeThreadId, activeProjectId, query, virtualized]);
  const virtualRows = list.getVirtualItems();
  const renderHeading = (group: (typeof groups)[number]) => <button
    className="finished-toggle"
    type="button"
    aria-expanded={group.open || Boolean(query)}
    onClick={group.toggle}
  >
    <ChevronRight size={12} className="category-chevron" />
    <group.icon size={14} className={`category-icon${group.id === "finished" ? " category-finished" : ""}`} />
    <span>{t(group.label, undefined, "conversations")}</span><span>{group.threads.length}</span>
  </button>;
  const reorder = async (source: string, target: string, edge?: "before" | "after") => {
    if (source === target || query || !activeProjectId) return;
    if (!groups.some((group) => group.threads.some((thread) => thread.id === source) && group.threads.some((thread) => thread.id === target))) return;
    const ordered = groups.flatMap((group) => group.threads.map((thread) => thread.id));
    const from = ordered.indexOf(source),
      to = ordered.indexOf(target);
    if (from < 0 || to < 0) return;
    ordered.splice(from, 1);
    ordered.splice(ordered.indexOf(target) + ((edge ?? (from < to ? "after" : "before")) === "after" ? 1 : 0), 0, source);
    const previous = useApp.getState().threads;
    useApp.setState((state) => {
      const threads = { ...state.threads };
      ordered.forEach((id, position) => { threads[id] = { ...threads[id]!, position }; });
      return { threads };
    });
    try {
      await api(`threads/reorder?projectId=${activeProjectId}`, {
        method: "POST",
        body: JSON.stringify({ ids: ordered }),
      });
    } catch (error) {
      useApp.setState((state) => {
        if (!ordered.every((id, position) => state.threads[id]?.position === position)) return state;
        const threads = { ...state.threads };
        ordered.forEach((id) => { threads[id] = { ...threads[id]!, position: previous[id]?.position }; });
        return { threads };
      });
      reportError(error);
    }
  };
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>, thread: ThreadMeta) => {
    dragCleanup.current();
    suppressClick.current = false;
    const control = (event.target as HTMLElement).closest("button, a, input, textarea");
    if (event.button !== 0 || !event.isPrimary || event.pointerType === "touch" || query || !connected ||
      (control && !control.classList.contains("thread-row"))) return;
    const element = event.currentTarget;
    const scroll = viewport.current;
    const group = groups.find((entry) => entry.threads.some((entry) => entry.id === thread.id));
    if (!scroll || !group) return;
    const indices = new Map(group.threads.map((entry, index) => [entry.id, index]));
    const sourceIndex = indices.get(thread.id)!;
    const pointerId = event.pointerId;
    const startX = event.clientX, startY = event.clientY, startScroll = scroll.scrollTop;
    dragHeight.current = element.parentElement!.offsetHeight;
    let x = startX, y = startY, active = false, frame = 0, lastTime = performance.now();
    let drop: typeof dropTarget;
    const update = (now: number) => {
      frame = 0;
      const bounds = scroll.getBoundingClientRect();
      const inside = x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom;
      const distance = y < bounds.top + 40 ? y - bounds.top - 40 : y > bounds.bottom - 40 ? y - bounds.bottom + 40 : 0;
      const entries = Array.from(scroll.querySelectorAll<HTMLElement>(".thread-entry")).flatMap(node => {
        const id = node.dataset.threadId!;
        const index = indices.get(id);
        return index === undefined ? [] : [{ id, index, rect: node.parentElement!.getBoundingClientRect() }];
      });
      const source = entries.find(entry => entry.id === thread.id);
      if (!source || !element.isConnected) { finish(false); return; }
      const first = entries.find(entry => entry.index === 0);
      const last = entries.find(entry => entry.index === group.threads.length - 1);
      const before = scroll.scrollTop;
      if (inside && distance) {
        const step = Math.max(-16, Math.min(16, distance * 0.4)) * Math.min(32, now - lastTime) / 16;
        const minimum = first ? Math.min(0, first.rect.top - bounds.top) : -Infinity;
        const maximum = last ? Math.max(0, last.rect.bottom - bounds.bottom) : Infinity;
        scroll.scrollTop += Math.max(minimum, Math.min(maximum, step));
      }
      lastTime = now;
      const scrolled = scroll.scrollTop - before;
      let next: typeof dropTarget;
      if (inside) {
        for (const { id, index, rect } of entries) {
          const top = rect.top - scrolled, bottom = rect.bottom - scrolled;
          if ((y < top && index !== 0) || (y >= bottom && index !== group.threads.length - 1)) continue;
          if (id !== thread.id) {
            const edge = y < top + rect.height / 2 ? "before" : "after";
            const destination = index + (edge === "after" ? 1 : 0) - (sourceIndex < index ? 1 : 0);
            if (destination !== sourceIndex) next = { id, edge };
          }
          break;
        }
      }
      const sourceTop = source.rect.top - scrolled;
      const minimum = Math.max(bounds.top, first ? first.rect.top - scrolled : -Infinity);
      const maximum = Math.max(minimum, Math.min(bounds.bottom, last ? last.rect.bottom - scrolled : Infinity) - source.rect.height);
      const top = sourceTop + y - startY + scroll.scrollTop - startScroll;
      const clamped = Math.max(minimum, Math.min(maximum, top));
      element.style.setProperty("--thread-drag-y", `${clamped - sourceTop}px`);
      if (drop?.id !== next?.id || drop?.edge !== next?.edge) {
        drop = next;
        setDropTarget(next);
      }
      if (scroll.scrollTop !== before) frame = requestAnimationFrame(update);
    };
    const finish = (commit: boolean) => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", cancel);
      document.removeEventListener("keydown", key);
      window.removeEventListener("blur", cancel);
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
      element.style.removeProperty("--thread-drag-y");
      dragCleanup.current = () => {};
      if (active) {
        active = false;
        suppressClick.current = true;
        if (commit && drop) void reorder(thread.id, drop.id, drop.edge);
        setDragging(undefined);
        setDropTarget(undefined);
      }
    };
    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      x = event.clientX;
      y = event.clientY;
      if (!active) {
        if (Math.hypot(x - startX, y - startY) < 6) return;
        active = true;
        element.setPointerCapture(pointerId);
        setDragging(thread.id);
      }
      event.preventDefault();
      if (!frame) frame = requestAnimationFrame(update);
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      if (active) {
        x = event.clientX;
        y = event.clientY;
        cancelAnimationFrame(frame);
        update(performance.now());
      }
      finish(true);
    };
    const cancel = () => finish(false);
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); finish(false); }
    };
    dragCleanup.current = cancel;
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", cancel);
    document.addEventListener("keydown", key);
    window.addEventListener("blur", cancel);
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
  const dragShifts = useMemo(() => {
    const shifts = new Map<string, number>();
    if (!dragging || !dropTarget) return shifts;
    const group = groups.find((entry) => entry.threads.some((thread) => thread.id === dragging));
    if (!group) return shifts;
    const from = group.threads.findIndex((thread) => thread.id === dragging);
    const target = group.threads.findIndex((thread) => thread.id === dropTarget.id);
    if (target < 0) return shifts;
    const to = target + (dropTarget.edge === "after" ? 1 : 0) - (from < target ? 1 : 0);
    for (let index = Math.min(from, to); index <= Math.max(from, to); index++) {
      if (index !== from) shifts.set(group.threads[index]!.id, from < to ? -dragHeight.current : dragHeight.current);
    }
    return shifts;
  }, [dragging, dropTarget, groups]);
  const renderThread = (thread: (typeof threads)[number]) => {
    const provider = providers.find((entry) => entry.id === thread.provider);
    const name = modelLabel(provider?.models ?? [], thread.model);
    const { status, label } = threadActivity(thread);
    const statusLabel = t(label);
    return (
      <div
        className="thread-entry"
        key={thread.id}
        data-thread-id={thread.id}
        data-category-end={groups.some((group) => group.threads.at(-1)?.id === thread.id)}
        data-dragging={dragging === thread.id}
        style={{ "--thread-shift": `${dragShifts.get(thread.id) ?? 0}px` } as CSSProperties}
        onPointerDown={(event) => startDrag(event, thread)}
        onDragStart={(event) => event.preventDefault()}
        onClickCapture={(event) => {
          if (suppressClick.current) {
            suppressClick.current = false;
            if (event.detail === 0) return;
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        <div className="thread-card" data-active={thread.id === activeThreadId} onPointerDownCapture={hidePreview}>
          <button
            type="button"
            className="thread-row"
            data-active={thread.id === activeThreadId}
            aria-label={thread.title}
            aria-description={new Date(thread.updatedAt).toLocaleString(currentLocale())}
            aria-describedby={preview?.threadId === thread.id ? previewId : undefined}
            aria-current={thread.id === activeThreadId ? "page" : undefined}
            onPointerEnter={(event) => { if (event.pointerType !== "touch") showPreview(event.currentTarget, thread.id); }}
            onPointerLeave={leavePreview}
            onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) showPreview(event.currentTarget, thread.id, true); }}
            onBlur={hidePreview}
            onClick={() => {
              hidePreview();
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
              <span className="thread-row-heading">
                <ProviderIcon provider={thread.provider} />
                <span className="thread-row-title">{thread.title}</span>
                {status !== "idle" && status !== "stopped" && (
                  <span className="thread-status" data-status={status} role="img" aria-label={statusLabel}>
                    <ThreadPulse status={status} />
                  </span>
                )}
              </span>
              {query.trim() && allProjects && (
                <span className="thread-row-meta">
                  <Folder size={12} />
                  {projects.find((entry) => entry.id === thread.projectId)?.name}
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
            <span className="thread-row-footer">
              <span className="thread-row-summary">
                <span className="thread-provider truncate">{name}</span>
                {thread.workspaceBranch && <span className="thread-row-branch"><GitBranch size={11} /><span className="truncate">{thread.workspaceBranch}</span></span>}
              </span>
            </span>
          </button>
          <div className="thread-row-actions" onPointerEnter={hidePreview}>
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
                (childrenByParent.get(thread.id) ?? []).some((child) => child.running)
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
          disabled={!connected || creatingThread || !activeProjectId || !providers.some((provider) => provider.available && provider.enabled)}
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
      <div className="rail-scroll">
        <div className="rail-list scroll" ref={viewport}
          onScroll={(event) => {
            hidePreview();
            event.currentTarget.parentElement?.toggleAttribute("data-scrolled", event.currentTarget.scrollTop > 0);
          }}
          onFocusCapture={(event) => {
            const index = event.target.closest<HTMLElement>("[data-index]")?.dataset.index;
            if (index !== undefined) setFocusedRow(rows[Number(index)]?.key);
          }}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setFocusedRow(undefined);
          }}
        >
          <div className="thread-list" data-virtualized={virtualized} data-dragging={Boolean(dragging)} style={virtualized ? { height: list.getTotalSize(), position: "relative" } : undefined}>
            {groups.map((group) => <section className="thread-category" data-category={group.id} key={group.id} style={virtualized ? { display: "contents" } : undefined}>
              {virtualized ? virtualRows.filter((item) => rows[item.index]?.group.id === group.id).map((item) => {
                const row = rows[item.index]!;
                return <div key={item.key} data-index={item.index} ref={list.measureElement} className="thread-list-item" style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}>
                  {row.thread ? renderThread(row.thread) : renderHeading(group)}
                </div>;
              }) : <>{renderHeading(group)}<Collapsible open={group.open || Boolean(query)} className="thread-category-content">{(group.open || query) && group.threads.map((thread) => <div className="thread-list-item" key={thread.id}>{renderThread(thread)}</div>)}</Collapsible></>}
            </section>)}
          </div>
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
      </div>
      {preview && threadMap[preview.threadId] && <ThreadPreview
        id={previewId}
        thread={threadMap[preview.threadId]!}
        anchor={preview.anchor}
        onClose={hidePreview}
        onPointerEnter={clearPreviewTimer}
        onPointerLeave={leavePreview}
      />}
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
