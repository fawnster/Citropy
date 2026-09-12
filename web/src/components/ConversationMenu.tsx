import { useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Clock,
  GitPullRequest,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  ArrowUp,
  ArrowDown,
  RefreshCw,
} from "lucide-react";
import { Menu } from "./Menu.tsx";
import { Modal } from "./Modal.tsx";
import { api, reportError } from "../lib/api.ts";
import type { ThreadMeta } from "../../../shared/protocol.ts";
import { useI18n } from "../lib/i18n.ts";

export async function organizeConversation(id: string, patch: object) {
  await api(`threads/organize?threadId=${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function ConversationMenu({
  thread,
  onMove,
}: {
  thread: ThreadMeta;
  onMove: (direction: number) => void;
}) {
  const t = useI18n();
  const [editing, setEditing] = useState<"title" | "pullRequest" | "snooze">();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [generatingTitle, setGeneratingTitle] = useState(false);
  const regenerateTitle = async () => {
    setGeneratingTitle(true);
    try { await api(`threads/title?threadId=${encodeURIComponent(thread.id)}`, { method: "POST" }); }
    catch (error) { reportError(error); }
    finally { setGeneratingTitle(false); }
  };
  const edit = (field: typeof editing) => {
    setEditing(field);
    setValue(
      field === "title"
        ? thread.title
        : field === "pullRequest"
          ? (thread.pullRequest ?? "")
          : "",
    );
    setError("");
  };
  const update = (patch: object) =>
    organizeConversation(thread.id, patch).catch(reportError);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      if (editing === "title")
        await organizeConversation(thread.id, { title: value.trim() });
      else
        await organizeConversation(
          thread.id,
          editing === "snooze"
            ? { snoozedUntil: new Date(value).getTime() }
            : { pullRequest: value.trim() },
        );
      setEditing(undefined);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Menu
        align="end"
        width={230}
        items={[
          {
            id: "pin",
            label: thread.pinned ? t("Unpin conversation") : t("Pin conversation"),
            icon: thread.pinned ? <PinOff size={15} /> : <Pin size={15} />,
            onSelect: () => update({ pinned: !thread.pinned }),
          },
          {
            id: "rename",
            label: t("Rename…"),
            icon: <Pencil size={15} />,
            onSelect: () => edit("title"),
          },
          ...(!thread.parentThreadId ? [{
            id: "generate-title",
            label: generatingTitle ? t("Naming conversation…") : t("Generate title"),
            icon: <RefreshCw size={15} />,
            disabled: generatingTitle,
            onSelect: () => void regenerateTitle(),
          }] : []),
          {
            id: "up",
            label: t("Move up"),
            icon: <ArrowUp size={15} />,
            onSelect: () => onMove(-1),
          },
          {
            id: "down",
            label: t("Move down"),
            icon: <ArrowDown size={15} />,
            onSelect: () => onMove(1),
          },
          {
            id: "pr",
            label: thread.pullRequest
              ? t("Edit pull request link…")
              : t("Link pull request…"),
            icon: <GitPullRequest size={15} />,
            onSelect: () => edit("pullRequest"),
          },
          ...(!thread.running
            ? [
                {
                  id: "snooze",
                  label: thread.snoozedUntil
                    ? t("Wake conversation")
                    : t("Snooze until…"),
                  icon: <Clock size={15} />,
                  onSelect: () =>
                    thread.snoozedUntil
                      ? update({ snoozedUntil: null })
                      : edit("snooze"),
                },
                {
                  id: "archive",
                  label: thread.archived
                    ? t("Restore conversation")
                    : t("Archive conversation"),
                  icon: thread.archived ? (
                    <ArchiveRestore size={15} />
                  ) : (
                    <Archive size={15} />
                  ),
                  onSelect: () => update({ archived: !thread.archived }),
                },
              ]
            : []),
        ]}
        trigger={({ id, open, toggle }) => (
          <button
            id={id}
            className="thread-more"
            type="button"
            aria-label={`${t("Organize")} ${thread.title}`}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={toggle}
          >
            <MoreHorizontal size={16} />
          </button>
        )}
      />
      {editing && (
        <Modal
          title={
            editing === "title"
              ? t("Rename conversation")
              : editing === "snooze"
                ? t("Snooze conversation")
                : t("Link a pull request")
          }
          description={
            editing === "snooze"
              ? t("Move this conversation out of your active list until the time you choose.")
              : undefined
          }
          onClose={() => setEditing(undefined)}
          onSubmit={save}
          busy={busy}
          initialFocus="input"
          footer={
            <>
              <button
                className="btn"
                data-cancel
                type="button"
                disabled={busy}
                onClick={() => setEditing(undefined)}
              >
                {t("Cancel")}
              </button>
              <button
                className="btn"
                data-variant="primary"
                disabled={busy || (editing !== "pullRequest" && !value.trim())}
              >
                {t("Save")}
              </button>
            </>
          }
        >
          <label className="feature-field">
            {editing === "title"
              ? t("Name")
              : editing === "snooze"
                ? t("Wake at")
                : t("GitHub pull request URL")}
            <input
              type={editing === "snooze" ? "datetime-local" : "text"}
              value={value}
              maxLength={editing === "title" ? 200 : 2000}
              onChange={(event) => setValue(event.target.value)}
              placeholder={
                editing === "pullRequest"
                  ? "https://github.com/owner/repo/pull/123"
                  : undefined
              }
            />
          </label>
          {error && (
            <p className="feature-error" role="alert">
              {error}
            </p>
          )}
        </Modal>
      )}
    </>
  );
}
