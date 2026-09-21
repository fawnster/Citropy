import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown } from "./icons.ts";
import { MessageBlock } from "./MessageBlock.tsx";
import { MessageNavigator } from "./MessageNavigator.tsx";
import { Working } from "./Working.tsx";
import { scaled, useApp, type AppState } from "../lib/store.ts";
import { loadThread, readThreadNotifications, refreshGit } from "../lib/actions.ts";
import { useStickToBottom } from "../lib/use-stick.ts";
import {
  timelineRows,
  sameTimelineRows,
  type TimelineRow,
} from "../lib/timeline.ts";
import { useI18n } from "../lib/i18n.ts";
import { normalizeTodos } from "../../../shared/todos.ts";

function partFingerprint(part: AppState["parts"][string] | undefined): string {
  if (!part) return "-";
  switch (part.kind) {
    case "text":
    case "reasoning":
      return `${part.kind === "text" ? "x" : "r"}${part.text.trim() ? 1 : 0}${part.complete === false ? 0 : 1}`;
    case "todo":
      return `d${normalizeTodos(part.items).length ? 1 : 0}`;
    case "question":
      return `q${part.status}`;
    case "tool":
      return `k${part.name}:${part.callId}:${part.images?.length ?? 0}:${part.imageFiles?.length ?? 0}`;
    case "images":
      return "i";
    case "notice":
      return `n${part.level}`;
    default:
      return part.kind;
  }
}

function timelineFingerprint(state: AppState, threadId: string): string {
  const order = state.order[threadId] ?? [];
  const thread = state.threads[threadId];
  const sections = [
    order.join(","),
    thread?.status ?? "",
    thread?.running ? "1" : "0",
    thread?.compacting ? "1" : "0",
    thread?.runStartedAt === undefined ? "" : String(thread.runStartedAt),
  ];
  for (const messageId of order) {
    const message = state.messages[messageId];
    if (!message) {
      sections.push(`@${messageId}`);
      continue;
    }
    sections.push(`>${message.role}:${message.ts}`);
    for (const partId of message.partIds)
      sections.push(`${partId}=${partFingerprint(state.parts[partId])}`);
  }
  for (const messageId of order) {
    for (const partId of state.messages[messageId]?.partIds ?? [])
      if (state.disclosures[partId]?.activity) sections.push(`^${partId}`);
  }
  return sections.join("|");
}

export function Conversation() {
  const t = useI18n();
  const searchMessageId = useApp((state) => state.searchMessageId);
  const searchShellId = useApp((state) => state.searchShellId);
  const threadId = useApp((state) => state.activeThreadId);
  const ids = useApp((state) => (threadId ? state.order[threadId] : undefined));
  const selectRows = useMemo(() => {
    let rows: TimelineRow[] = [];
    let fingerprint: string | undefined;
    return (state: ReturnType<typeof useApp.getState>) => {
      const key = threadId ? timelineFingerprint(state, threadId) : "";
      if (key === fingerprint) return rows;
      fingerprint = key;
      const next = threadId ? timelineRows(state, threadId) : [];
      if (!sameTimelineRows(rows, next)) rows = next;
      return rows;
    };
  }, [threadId]);
  const rows = useApp(selectRows);
  const continuesReply = useApp((state) => state.messages[rows.at(-1)?.messageId ?? ""]?.role === "assistant");
  const lastMessage = useApp((state) => state.messages[ids?.at(-1) ?? ""]);
  const status = useApp((state) =>
    threadId ? state.threads[threadId]?.status : undefined,
  );
  const running = useApp((state) =>
    threadId ? state.threads[threadId]?.running : false,
  );
  const error = useApp((state) =>
    threadId ? state.threads[threadId]?.error : undefined,
  );
  const activeTool = useApp((state) =>
    threadId ? state.threads[threadId]?.activeTool : undefined,
  );
  const compacting = useApp((state) => Boolean(threadId && state.threads[threadId]?.compacting));
  const startedAt = useApp((state) => {
    if (!threadId) return 0;
    return state.threads[threadId]?.runStartedAt ??
      state.messages[(state.order[threadId] ?? []).findLast((id) => state.messages[id]?.role === "user") ?? ""]?.ts ??
      state.threads[threadId]?.updatedAt ?? 0;
  });
  const connected = useApp((state) => state.connected);
  const loaded = useApp((state) => Boolean(threadId && state.loaded[threadId]));
  const followRequest = useApp((state) => state.followRequest);
  const uiScale = useApp((state) => state.uiScale);
  const [selectedMessageId, setSelectedMessageId] = useState<string>();
  const {
    viewport,
    content,
    atBottom,
    nearBottom,
    scrollToBottom,
    stopFollowing,
  } = useStickToBottom<HTMLDivElement, HTMLDivElement>();
  const virtualized = rows.length > 40;
  const getItemKey = useCallback((index: number) => rows[index]!.key, [rows]);
  const timeline = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => viewport.current,
    getItemKey,
    estimateSize: () => scaled(180),
    initialOffset: () => viewport.current?.scrollTop ?? rows.length * scaled(180),
    paddingStart: scaled(30),
    overscan: virtualized ? 4 : 40,
    measureElement: (element) => element.offsetHeight,
  });
  timeline.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    const canvas = viewport.current;
    const offset = instance.scrollOffset ?? 0;
    return Boolean(canvas && offset <= canvas.scrollHeight - canvas.clientHeight + 1 && item.end <= offset + instance.scrollAdjustments);
  };
  const virtualItems = timeline.getVirtualItems();

  useEffect(() => {
    if (threadId && connected) {
      loadThread(threadId);
      const thread = useApp.getState().threads[threadId];
      if (thread) refreshGit(thread.projectId);
    }
  }, [threadId, connected]);

  useLayoutEffect(() => {
    setSelectedMessageId(undefined);
    scrollToBottom("auto");
  }, [threadId, followRequest, scrollToBottom]);

  useLayoutEffect(() => {
    if (atBottom) scrollToBottom("instant");
  }, [uiScale, atBottom, scrollToBottom]);

  const readSince = useRef(Date.now());
  useLayoutEffect(() => {
    readSince.current = Date.now();
  }, [threadId]);

  useLayoutEffect(() => {
    const update = () => {
      const readingThreadId =
        nearBottom &&
        document.visibilityState === "visible" &&
        document.hasFocus()
          ? threadId
          : null;
      if (useApp.getState().readingThreadId !== readingThreadId) {
        useApp.setState({ readingThreadId });
        if (readingThreadId) readThreadNotifications(readingThreadId, readSince.current);
      }
    };
    update();
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
      if (useApp.getState().readingThreadId === threadId)
        useApp.setState({ readingThreadId: null });
    };
  }, [threadId, nearBottom]);

  useEffect(() => {
    if (!searchMessageId && !searchShellId) return;
    const state = useApp.getState();
    let messageId = searchMessageId;
    let partId: string | undefined;
    if (searchShellId) {
      if (state.shells[searchShellId]?.threadId !== threadId) return;
      for (const id of ids ?? []) {
        partId = state.messages[id]?.partIds.find(id => {
          const part = state.parts[id];
          return part?.kind === "tool" && `${threadId}:${part.callId}` === searchShellId;
        });
        if (partId) { messageId = id; break; }
      }
      if (!partId) {
        if (loaded) useApp.setState(state => {
          if (state.searchShellId !== searchShellId) return state;
          return { searchShellId: null, toasts: [...state.toasts, {
            id: `shell-${searchShellId}`, level: "info", text: t("This command is no longer in the conversation history. Its recent output is available in Running shells."),
          }] };
        });
        return;
      }
    }
    if (!threadId || !messageId || !ids?.includes(messageId)) return;
    stopFollowing();
    const activity = rows.find(row => row.row?.kind === "activity" && row.row.messageIds.includes(messageId))?.row;
    const expanding = activity?.kind === "activity" && !activity.open;
    let disclosures = expanding ? {
      ...state.disclosures,
      [activity.id]: { ...state.disclosures[activity.id], activity: true },
    } : state.disclosures;
    const expandedRows = expanding ? timelineRows({ ...state, disclosures }, threadId) : rows;
    const index = expandedRows.findIndex(({ row, messageId: owner }) => partId
      ? row?.kind === "group" && row.ids.includes(partId)
      : owner === messageId);
    const group = expandedRows[index]?.row;
    if (partId && group?.kind === "group" &&
      (!disclosures[group.ids[0]!]?.group || !disclosures[partId]?.tool)) {
      disclosures = { ...disclosures };
      const id = group.ids[0]!;
      disclosures[id] = { ...disclosures[id], group: true };
      disclosures[partId] = { ...disclosures[partId], tool: true };
    }
    if (disclosures !== state.disclosures) useApp.setState({ disclosures });
    if (expanding) return;
    let frame = requestAnimationFrame(() => {
      if (index !== -1) {
        setSelectedMessageId(messageId!);
        timeline.scrollToIndex(index, { align: "start" });
      }
      if (!partId) {
        useApp.setState({ searchMessageId: null });
        return;
      }
      frame = requestAnimationFrame(() => {
        const element = document.getElementById(`tool-${partId}`);
        const row = element?.closest<HTMLElement>(".timeline-row");
        const item = timeline.getVirtualItems().find(item => item.index === index);
        if (!element || !row || !item) return;
        const offset = item.start + element.getBoundingClientRect().top - row.getBoundingClientRect().top - scaled(16);
        timeline.scrollToOffset(offset, { align: "start" });
        element.querySelector<HTMLButtonElement>(".tool-head")?.focus({ preventScroll: true });
        useApp.setState({ searchShellId: null });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [searchMessageId, searchShellId, threadId, loaded, ids, rows, timeline, stopFollowing, t]);

  const busy =
    compacting || status === "thinking" || status === "working" || status === "queued";
  const activityRunning = rows.some(row => row.row?.kind === "activity" && row.row.active && !row.row.open);
  const messages = ids ?? [];
  const visibleItem = virtualItems.find((item) => item.end > (timeline.scrollOffset ?? 0) + 30);
  const jumpToMessage = useCallback((messageId: string) => {
    useApp.setState({ searchMessageId: messageId });
  }, []);

  return (
    <div className="conversation-viewport">
      <div
        className="canvas scroll"
        ref={viewport}
        onWheel={() => setSelectedMessageId(undefined)}
        onPointerDown={() => setSelectedMessageId(undefined)}
        onKeyDown={(event) => {
          if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key))
            setSelectedMessageId(undefined);
        }}
      >
        <div
          className="canvas-inner"
          ref={content}
        >
          {messages.length === 0 && !busy && (
            <div className="canvas-hint">
              <p>
                {t("This thread is empty. Describe what you want changed and the provider will work in your repository.")}
              </p>
            </div>
          )}
          <div
            className="timeline-rows"
            style={{ height: timeline.getTotalSize() }}
          >
            {virtualItems.map((item) => {
              const row = rows[item.index]!;
              return (
                <div
                  key={item.key}
                  className="timeline-row"
                  data-index={item.index}
                  ref={timeline.measureElement}
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <MessageBlock
                    messageId={row.messageId}
                    row={row.row}
                    first={row.first}
                    separator={row.separator}
                    last={row.last && !(busy && continuesReply && item.index === rows.length - 1)}
                    streaming={
                      Boolean(running) && row.messageId === messages.at(-1)
                    }
                  />
                </div>
              );
            })}
          </div>
          {status === "error" && error && (
            <div className="thread-error" role="alert">
              {error}
            </div>
          )}
          {busy && !activityRunning && <MessageBlock
            messageId={lastMessage?.role === "assistant" ? lastMessage.id : undefined}
            first={!continuesReply && !rows.some(row => row.row?.kind === "activity" && row.row.active)}
            last
            streaming={false}
          >
            <Working status={status} tool={activeTool} compacting={compacting} startedAt={startedAt} />
          </MessageBlock>}
          <div className="canvas-tail" />
        </div>
      </div>

      <MessageNavigator
        rows={rows}
        activeMessageId={selectedMessageId ?? (atBottom ? rows.at(-1)?.messageId : visibleItem && rows[visibleItem.index]?.messageId)}
        onSelect={jumpToMessage}
      />

      <div className="conversation-jump">
        <AnimatePresence>
          {!atBottom && (
            <motion.button
              type="button"
              className="jump"
              onClick={() => {
                setSelectedMessageId(undefined);
                scrollToBottom(virtualized ? "auto" : "smooth");
              }}
              initial={{ opacity: 0, y: 8, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.96 }}
              transition={{ type: "spring", bounce: 0.2, duration: 0.34 }}
            >
              <ChevronDown size={14} />
              {t("Latest")}
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
