import { useI18n } from "../lib/i18n.ts";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, CircleAlert, Info, X } from "lucide-react";
import { dismissToast, useApp, type Toast } from "../lib/store.ts";
import { send } from "../lib/socket.ts";
import type { NotificationTarget } from "../../../shared/protocol.ts";

function ToastItem({
  toast,
  onOpen,
}: {
  toast: Toast;
  onOpen: (target: NotificationTarget) => void;
}) {
  const t = useI18n();
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(
      () => dismissToast(toast.id),
      toast.level === "error" ? 10_000 : 6_000,
    );
    return () => clearTimeout(timer);
  }, [toast.id, toast.level, paused]);
  const Icon =
    toast.level === "success"
      ? Check
      : toast.level === "info"
        ? Info
        : CircleAlert;
  return (
    <motion.div
      className="toast"
      data-level={toast.level}
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: 12 }}
      transition={{ duration: 0.16 }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      role={toast.level === "error" ? "alert" : "status"}
    >
      <span className="toast-symbol">
        <Icon size={17} />
      </span>
      <div className="toast-copy">
        {toast.title && <strong>{t(toast.title)}</strong>}
        <span className="toast-text">{toast.target ? toast.text : t(toast.text)}</span>
        {toast.target && (
          <button
            className="toast-open"
            type="button"
            onClick={() => {
              send({ t: "notifications.read", ids: [toast.id] });
              onOpen(toast.target!);
              dismissToast(toast.id);
            }}
          >
            {t(toast.target.view === "chat" ? "Open conversation" : toast.target.view === "git" ? "Open source control" : toast.target.view === "settings" ? "Open settings" : "Open GitHub")}
          </button>
        )}
      </div>
      <button
        className="icon-btn"
        type="button"
        onClick={() => dismissToast(toast.id)}
        aria-label={t("Dismiss notification")}
        title={t("Dismiss notification")}
      >
        <X size={15} />
      </button>
    </motion.div>
  );
}

export function Toasts({
  onOpen,
}: {
  onOpen: (target: NotificationTarget) => void;
}) {
  const t = useI18n();
  const toasts = useApp((state) => state.toasts);
  return (
    <div className="toasts" aria-label={t("Recent notifications")}>
      <AnimatePresence initial={false}>
        {toasts.slice(-3).map((toast) => (
          <ToastItem key={toast.id} toast={toast} onOpen={onOpen} />
        ))}
      </AnimatePresence>
    </div>
  );
}
