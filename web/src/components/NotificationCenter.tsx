import { useEffect, useRef, useState } from "react";
import {
  Bell,
  BellRing,
  CheckCheck,
  Check,
  GitBranch,
  Github,
  MessageSquare,
  Trash2,
  X,
  CircleAlert,
} from "lucide-react";
import { useApp } from "../lib/store.ts";
import { send } from "../lib/socket.ts";
import { ago } from "../lib/format.ts";
import type { NotificationTarget } from "../../../shared/protocol.ts";

export function NotificationCenter({
  onOpen,
}: {
  onOpen: (target: NotificationTarget) => void;
}) {
  const notifications = useApp((state) => state.notifications);
  const connected = useApp((state) => state.connected);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const unread = notifications.filter((entry) => !entry.read).length;
  const visible = notifications.filter(
    (entry) => filter === "all" || !entry.read,
  );
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    const outside = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", outside, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", outside, true);
    };
  }, [open]);
  return (
    <div
      className="notifications-wrap"
      ref={wrap}
      onBlur={(event) => {
        if (
          event.relatedTarget &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="icon-btn notification-trigger"
        title="Notifications"
        aria-label={
          unread ? `Notifications, ${unread} unread` : "Notifications"
        }
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
      >
        <Bell size={17} />
        {unread > 0 && <span className="notification-dot" />}
      </button>
      {open && (
        <section
          className="notification-center"
          role="dialog"
          aria-label="Notifications"
        >
          <header>
            <div>
              <h2>Notifications</h2>
              <span>{unread ? `${unread} unread` : "You're up to date"}</span>
            </div>
            <button
              className="icon-btn"
              type="button"
              title="Mark all read"
              disabled={!unread || !connected}
              onClick={() => send({ t: "notifications.read" })}
            >
              <CheckCheck size={17} />
            </button>
            <button
              className="icon-btn"
              type="button"
              title="Close notifications"
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              <X size={17} />
            </button>
          </header>
          <div
            className="notification-filters"
            role="group"
            aria-label="Filter notifications"
          >
            <button
              type="button"
              aria-pressed={filter === "all"}
              onClick={() => setFilter("all")}
            >
              All activity
            </button>
            <button
              type="button"
              aria-pressed={filter === "unread"}
              onClick={() => setFilter("unread")}
            >
              Unread {unread > 0 && <span>{unread}</span>}
            </button>
          </div>
          <div className="notification-list scroll">
            {visible.map((entry) => {
              const Icon =
                entry.level === "error"
                  ? CircleAlert
                  : entry.kind === "git"
                    ? GitBranch
                    : entry.kind === "github"
                      ? Github
                      : MessageSquare;
              return (
                <article
                  key={entry.id}
                  className="notification-row"
                  data-unread={!entry.read}
                >
                  <span
                    className="notification-symbol"
                    data-level={entry.level}
                  >
                    <Icon size={17} />
                  </span>
                  <button
                    type="button"
                    className="notification-copy"
                    onClick={() => {
                      send({ t: "notifications.read", ids: [entry.id] });
                      onOpen(entry.target);
                      setOpen(false);
                    }}
                  >
                    <strong>{entry.title}</strong>
                    <span>{entry.text}</span>
                    <time
                      dateTime={new Date(entry.createdAt).toISOString()}
                      title={new Date(entry.createdAt).toLocaleString()}
                    >
                      {ago(entry.createdAt)}
                    </time>
                  </button>
                  {!entry.read && (
                    <button
                      type="button"
                      className="icon-btn notification-read"
                      title="Mark read"
                      disabled={!connected}
                      onClick={() =>
                        send({ t: "notifications.read", ids: [entry.id] })
                      }
                    >
                      <Check size={14} />
                    </button>
                  )}
                </article>
              );
            })}
            {!visible.length && (
              <div className="notification-empty">
                <BellRing size={27} />
                <strong>
                  {filter === "unread" ? "All caught up" : "Nothing here yet"}
                </strong>
                <p>
                  Chat replies and completed Git or GitHub actions will appear
                  here.
                </p>
              </div>
            )}
          </div>
          <footer>
            <span>Last 100 notifications</span>
            <button
              type="button"
              disabled={
                !connected || !notifications.some((entry) => entry.read)
              }
              onClick={() => send({ t: "notifications.clear" })}
            >
              <Trash2 size={13} />
              Clear read
            </button>
          </footer>
        </section>
      )}
    </div>
  );
}
