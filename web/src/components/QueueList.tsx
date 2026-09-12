import { useEffect, useId, useState } from "react";
import { useI18n } from "../lib/i18n.ts";
import { ChevronDown, ChevronUp, Clock3, Paperclip } from "lucide-react";
import { Pencil, X } from "./icons.ts";
import { editQueued } from "../lib/actions.ts";
import { reportError } from "../lib/api.ts";
import { flushHeld, takeHeld } from "../lib/offline.ts";
import { send } from "../lib/socket.ts";
import { useApp } from "../lib/store.ts";
import type {
  ProviderInfo,
  QueuedMessage,
  ThreadMeta,
} from "../../../shared/protocol.ts";

const COMMAND = /^\/[\w.:-]+(?:\s|$)/;
const NONE: QueuedMessage[] = [];

export function QueueList({
  thread,
  provider,
  onEdit,
}: {
  thread: ThreadMeta;
  provider?: ProviderInfo;
  onEdit: (item: QueuedMessage) => void;
}) {
  const t = useI18n();
  const connected = useApp((state) => state.connected);
  const held = useApp((state) => state.offline[thread.id] ?? NONE);
  const queued = thread.queue ?? NONE;
  const count = queued.length + held.length;
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  useEffect(() => {
    setExpanded(false);
  }, [thread.id]);
  useEffect(() => {
    if (!count) setExpanded(false);
  }, [count]);
  if (!queued.length && !held.length) return null;
  const latest = [...queued, ...held].reduce((last, item) =>
    item.createdAt >= last.createdAt ? item : last,
  );
  const state = !connected
      ? t("Sends when Citropy reconnects")
    : queued.length && thread.running
      ? t("Sends when {provider} finishes", { provider: provider?.label ?? t("the provider") })
      : queued.length
        ? t("Paused until the next reply finishes")
        : t("Not sent yet");
  const steer =
    thread.running && !thread.compacting ? provider?.steerHint : undefined;
  const edit = (item: QueuedMessage) =>
    editQueued(thread.id, item.id)
      .then(() => onEdit(item))
      .catch(reportError);
  const editHeld = (id: string) => {
    try {
      onEdit(takeHeld(thread.id, id));
    } catch (error) {
      reportError(error);
    }
  };
  const removeHeld = (id: string) => {
    try {
      takeHeld(thread.id, id);
    } catch (error) {
      reportError(error);
    }
  };

  return (
    <div className="composer-queue">
      <button
        type="button"
        className="composer-queue-summary"
        aria-expanded={expanded}
        aria-controls={id}
        aria-label={`${expanded ? t("Collapse") : t("Expand")} ${count} ${t(count === 1 ? "queued message" : "queued messages")}`}
        title={state}
        onClick={() => setExpanded((value) => !value)}
      >
        <Clock3 size={14} />
        <strong>
          {t("Queued")} <span className="composer-queue-count">{count}</span>
        </strong>
        <span className="composer-queue-divider" />
        <QueuedText item={latest} />
        <ChevronDown size={14} className="composer-queue-chevron" />
      </button>
      <div id={id} hidden={!expanded} className="composer-queue-details">
        <p className="composer-queue-state">{state}</p>
        <ol className="composer-queue-list scroll" aria-label={t("Queued messages")}>
          {queued.map((item, index) => (
            <li className="composer-queue-item" key={item.id}>
              <QueuedText item={item} />
              <div className="composer-queue-actions">
                {(!thread.running ||
                  (steer && !COMMAND.test(item.text.trim()))) && (
                  <button
                    type="button"
                    className="btn"
                    disabled={!connected}
                    title={thread.running ? steer : t("Send this message now.")}
                    onClick={() =>
                      send({
                        t: "queue.send",
                        threadId: thread.id,
                        id: item.id,
                      })
                    }
                  >
                    {thread.running ? t("Send now") : t("Send")}
                  </button>
                )}
                {index > 0 && (
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={t("Move up")}
                    title={t("Move up")}
                    disabled={!connected}
                    onClick={() =>
                      send({
                        t: "queue.move",
                        threadId: thread.id,
                        id: item.id,
                        index: index - 1,
                      })
                    }
                  >
                    <ChevronUp size={15} />
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={t("Edit")}
                  title={t("Edit")}
                  disabled={!connected}
                  onClick={() => void edit(item)}
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={t("Remove")}
                  title={t("Remove")}
                  disabled={!connected}
                  onClick={() =>
                    send({
                      t: "queue.remove",
                      threadId: thread.id,
                      id: item.id,
                    })
                  }
                >
                  <X size={15} />
                </button>
              </div>
            </li>
          ))}
          {held.map((item) => (
            <li className="composer-queue-item" key={item.id}>
              <QueuedText item={item} />
              <span className="composer-queue-note">
                {connected ? t("Not sent") : t("Waiting for connection")}
              </span>
              <div className="composer-queue-actions">
                {connected && (
                  <button
                    type="button"
                    className="btn"
                    title={t("Try sending it again.")}
                    onClick={() => void flushHeld()}
                  >
                    {t("Send")}
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={t("Edit")}
                  title={t("Edit")}
                  onClick={() => editHeld(item.id)}
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={t("Remove")}
                  title={t("Remove")}
                  onClick={() => removeHeld(item.id)}
                >
                  <X size={15} />
                </button>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function QueuedText({ item }: { item: QueuedMessage }) {
  const files = item.attachments ?? [];
  const names = files.map((file) => file.label).join(", ");
  return (
    <>
      <span className="composer-queue-text truncate" title={item.text}>
        {item.text.trim() || names}
      </span>
      {files.length > 0 && (
        <span className="composer-queue-files" title={names}>
          <Paperclip size={12} />
          {files.length}
        </span>
      )}
    </>
  );
}
