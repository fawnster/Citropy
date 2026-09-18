import { useId, useState } from "react";
import { AnimatePresence } from "motion/react";
import { GitBranch, RotateCcw, FileDiff, MessagesSquare, Layers } from "lucide-react";
import { api, reportError } from "../lib/api.ts";
import { selectThread, useApp } from "../lib/store.ts";
import { useI18n } from "../lib/i18n.ts";
import { Modal } from "./Modal.tsx";
import { TaskReview } from "./TaskReview.tsx";
import { fileRestoreIssue } from "../../../shared/review.ts";
import type { ThreadMeta } from "../../../shared/protocol.ts";

export function MessageActions({ thread, messageId, user }: { thread: ThreadMeta; messageId: string; user: boolean }) {
  const t = useI18n();
  const [dialog, setDialog] = useState<"restore" | "review">();
  const [mode, setMode] = useState<"conversation" | "files" | "both">("conversation");
  const id = useId();
  const connected = useApp(state => state.connected);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const checkpoint = thread.checkpoints?.find(entry => entry.messageId === messageId);
  const fileIssue = fileRestoreIssue(thread.checkpoints, messageId);
  const unavailable = fileIssue === "missing"
    ? t("No file checkpoint was saved for this message.")
    : fileIssue === "incomplete"
      ? t("No completed file checkpoint is available for this task yet.")
      : fileIssue === "shared"
        ? t("Another task worked in this folder. Only conversation history can be restored.")
        : undefined;
  const restoreDisabled = busy || thread.running || thread.compacting || !connected || (mode !== "conversation" && Boolean(fileIssue));
  const choices = [
    { value: "conversation", label: t("Conversation only"), description: t("Rewind the chat and start a new provider session."), icon: MessagesSquare },
    { value: "files", label: t("Files only"), description: t("Restore file changes since this message. Keep the chat."), icon: FileDiff },
    { value: "both", label: t("Files and conversation"), description: t("Restore file changes and rewind the chat together."), icon: Layers },
  ] as const;
  const restore = async () => {
    if (restoreDisabled) return;
    setBusy(true); setError("");
    try { await api(`threads/restore?threadId=${thread.id}`, { method: "POST", body: JSON.stringify({ messageId, mode }) }); setDialog(undefined); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  };
  const fork = async () => {
    setBusy(true);
    try {
      const next = await api<ThreadMeta>(`threads/fork?threadId=${thread.id}`, { method: "POST", body: JSON.stringify({ messageId }) });
      useApp.setState(state => ({ threads: { ...state.threads, [next.id]: next } }));
      selectThread(next.id);
    } catch (error) { reportError(error); } finally { setBusy(false); }
  };
  if (thread.nativeAgentId) return null;
  return <><span className="message-actions">
    <button className="icon-btn" type="button" aria-label={t("Branch from this message")} title={t("Branch from this message")} disabled={busy} onClick={() => void fork()}><GitBranch size={13} /></button>
    {user && <button className="icon-btn" type="button" aria-label={t("Restore before this message")} title={t("Restore before this message")} disabled={busy || thread.running} onClick={() => { setMode("conversation"); setDialog("restore"); setError(""); }}><RotateCcw size={13} /></button>}
    {checkpoint?.before && <button className="icon-btn" type="button" aria-label={t("Review this turn")} title={t("Review this turn")} onClick={() => setDialog("review")}><FileDiff size={13} /></button>}
  </span>
    <AnimatePresence>
      {dialog === "review" && <TaskReview thread={thread} messageId={messageId} onClose={() => setDialog(undefined)} />}
      {dialog === "restore" && <Modal
        title={t("Restore before this message")}
        className="restore-dialog"
        busy={busy}
        onClose={() => setDialog(undefined)}
        onSubmit={() => void restore()}
        description={t("Return to the point before this message.")}
        footer={<>
          <button className="btn" type="button" data-cancel disabled={busy} onClick={() => setDialog(undefined)}>{t("Cancel")}</button>
          <button className="btn" data-variant="primary" disabled={restoreDisabled}>{t(busy ? "Restoring…" : "Restore")}</button>
        </>}
      >
        <fieldset className="restore-options" aria-label={t("What to restore")} disabled={busy}>
          {choices.map(({ value, label, description, icon: Icon }) => {
            const disabled = value !== "conversation" && Boolean(fileIssue);
            return <label className="restore-choice" key={value}>
              <Icon size={18} aria-hidden="true" />
              <span className="restore-choice-text">
                <strong id={`${id}-${value}-label`}>{label}</strong>
                <small id={`${id}-${value}-description`}>{description}</small>
              </span>
              <input
                type="radio"
                name={`${id}-mode`}
                value={value}
                checked={mode === value}
                disabled={disabled}
                onChange={() => setMode(value)}
                aria-labelledby={`${id}-${value}-label`}
                aria-describedby={disabled ? `${id}-unavailable` : `${id}-${value}-description`}
              />
            </label>;
          })}
        </fieldset>
        {unavailable && <p className="restore-unavailable" id={`${id}-unavailable`} role="status">{unavailable}</p>}
        <p className="restore-note">{t("Running commands and external services are not undone. Redo is available until your next message.")}</p>
        {error && <p className="feature-error" role="alert">{error}</p>}
      </Modal>}
    </AnimatePresence>
  </>;
}
