import { useCallback, useEffect, useLayoutEffect, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown } from "./icons.ts";
import { MessageBlock } from "./MessageBlock.tsx";
import { MessageNavigator } from "./MessageNavigator.tsx";
import { Working } from "./Working.tsx";
import { useApp } from "../lib/store.ts";
import { loadThread, refreshGit } from "../lib/actions.ts";
import { useStickToBottom } from "../lib/use-stick.ts";
import {
  timelineRows,
  sameTimelineRows,
  type TimelineRow,
} from "../lib/timeline.ts";

export function Conversation() {
  const searchMessageId = useApp((state) => state.searchMessageId);
  const threadId = useApp((state) => state.activeThreadId);
  const ids = useApp((state) => (threadId ? state.order[threadId] : undefined));
  const selectRows = useMemo(() => {
    let rows: TimelineRow[] = [];
    let previous: ReturnType<typeof useApp.getState> | undefined;
    return (state: ReturnType<typeof useApp.getState>) => {
      if (
        state.messages === previous?.messages &&
        state.parts === previous.parts &&
        state.order === previous.order
      )
        return rows;
      previous = state;
      const next = threadId ? timelineRows(state, threadId) : [];
      if (!sameTimelineRows(rows, next)) rows = next;
      return rows;
    };
  }, [threadId]);
  const rows = useApp(selectRows);
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
  const connected = useApp((state) => state.connected);
  const followRequest = useApp((state) => state.followRequest);
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
    estimateSize: () => 180,
    initialOffset: () => viewport.current?.scrollTop ?? rows.length * 180,
    paddingStart: 30,
    overscan: virtualized ? 4 : 40,
    measureElement: (element) => element.offsetHeight,
  });

  useEffect(() => {
    if (threadId && connected) {
      loadThread(threadId);
      const thread = useApp.getState().threads[threadId];
      if (thread) refreshGit(thread.projectId);
    }
  }, [threadId, connected]);

  useLayoutEffect(() => {
    scrollToBottom("auto");
  }, [threadId, followRequest, scrollToBottom]);

  useLayoutEffect(() => {
    const update = () => {
      const readingThreadId =
        nearBottom &&
        document.visibilityState === "visible" &&
        document.hasFocus()
          ? threadId
          : null;
      if (useApp.getState().readingThreadId !== readingThreadId)
        useApp.setState({ readingThreadId });
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
    if (!searchMessageId || !ids?.includes(searchMessageId)) return;
    const frame = requestAnimationFrame(() => {
      stopFollowing();
      if (virtualized) {
        const index = rows.findIndex(
          (row) => row.messageId === searchMessageId,
        );
        if (index !== -1) timeline.scrollToIndex(index, { align: "start" });
      }
      document
        .getElementById(`message-${searchMessageId}`)
        ?.scrollIntoView({ block: "center" });
      useApp.setState({ searchMessageId: null });
    });
    return () => cancelAnimationFrame(frame);
  }, [searchMessageId, ids, rows, virtualized, timeline, stopFollowing]);

  const busy =
    status === "thinking" || status === "working" || status === "queued";
  const messages = ids ?? [];
  const virtualItems = timeline.getVirtualItems();
  const visibleItem = virtualItems.find((item) => item.end > (timeline.scrollOffset ?? 0) + 30);
  const jumpToMessage = useCallback((messageId: string) => {
    useApp.setState({ searchMessageId: messageId });
  }, []);

  return (
    <div className="conversation-viewport">
      <div className="canvas scroll" ref={viewport}>
        <div
          className="canvas-inner"
          ref={content}
        >
          {messages.length === 0 && (
            <div className="canvas-hint">
              <p>
                This thread is empty. Describe what you want changed and the
                provider will work in your repository.
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
                    last={row.last}
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
          {busy && <Working status={status} tool={activeTool} />}
          <div className="canvas-tail" />
        </div>
      </div>

      <MessageNavigator
        rows={rows}
        activeMessageId={atBottom ? messages.at(-1) : visibleItem && rows[visibleItem.index]?.messageId}
        onSelect={jumpToMessage}
      />

      <div className="conversation-jump">
        <AnimatePresence>
          {!atBottom && (
            <motion.button
              type="button"
              className="jump"
              onClick={() => scrollToBottom(virtualized ? "auto" : "smooth")}
              initial={{ opacity: 0, y: 8, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.96 }}
              transition={{ type: "spring", bounce: 0.2, duration: 0.34 }}
            >
              <ChevronDown size={14} />
              Latest
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
