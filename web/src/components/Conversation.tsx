import { useEffect, useLayoutEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown } from "./icons.ts";
import { MessageBlock } from "./MessageBlock.tsx";
import { Working } from "./Working.tsx";
import { useApp } from "../lib/store.ts";
import { loadThread, refreshGit } from "../lib/actions.ts";
import { useStickToBottom } from "../lib/use-stick.ts";

export function Conversation() {
  const searchMessageId = useApp((state) => state.searchMessageId);
  const threadId = useApp((state) => state.activeThreadId);
  const ids = useApp((state) => (threadId ? state.order[threadId] : undefined));
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
  const { viewport, content, atBottom, nearBottom, scrollToBottom } =
    useStickToBottom<HTMLDivElement, HTMLDivElement>();

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
      document
        .getElementById(`message-${searchMessageId}`)
        ?.scrollIntoView({ block: "center" });
      useApp.setState({ searchMessageId: null });
    });
    return () => cancelAnimationFrame(frame);
  }, [searchMessageId, ids]);

  const busy =
    status === "thinking" || status === "working" || status === "queued";
  const messages = ids ?? [];

  return (
    <div className="conversation-viewport">
      <div className="canvas scroll" ref={viewport}>
        <div className="canvas-inner" ref={content}>
          {messages.length === 0 && (
            <div className="canvas-hint">
              <p>
                This thread is empty. Describe what you want changed and the
                provider will work in your repository.
              </p>
            </div>
          )}
          {messages.map((id, index) => (
            <MessageBlock
              key={id}
              messageId={id}
              streaming={Boolean(running) && index === messages.length - 1}
            />
          ))}
          {status === "error" && error && (
            <div className="thread-error" role="alert">
              {error}
            </div>
          )}
          {busy && <Working status={status} tool={activeTool} />}
          <div className="canvas-tail" />
        </div>
      </div>

      <div className="conversation-jump">
        <AnimatePresence>
          {!atBottom && (
            <motion.button
              type="button"
              className="jump"
              onClick={() => scrollToBottom()}
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
