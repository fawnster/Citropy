import { useState } from "react";
import { ArrowRight, LoaderCircle, GitBranch } from "lucide-react";
import { Modal } from "./Modal.tsx";
import type { GitOperation } from "../../../shared/protocol.ts";
import { useI18n } from "../lib/i18n.ts";

export interface GitDialogAction {
  operation: GitOperation;
  title: string;
  description: string;
  label: string;
  value?: string;
  fields?: "branch" | "stash" | "remote";
  danger?: boolean;
}

export function GitDialog({
  action,
  busy,
  connected,
  error,
  errorDetail,
  returnFocus,
  onClose,
  onSubmit,
}: {
  action: GitDialogAction;
  busy: boolean;
  connected: boolean;
  error: string;
  errorDetail?: string;
  returnFocus: HTMLElement | null;
  onClose: () => void;
  onSubmit: (value: string, remote?: string) => Promise<void>;
}) {
  const t = useI18n();
  const [value, setValue] = useState(action.value ?? "");
  const [remote, setRemote] = useState("origin");

  const valid =
    !action.fields ||
    action.fields === "stash" ||
    (value.trim() && (action.fields !== "remote" || remote.trim()));

  return (
    <Modal
      title={t(action.title)}
      description={t(action.description)}
      icon={<GitBranch size={21} />}
      busy={busy}
      danger={action.danger}
      returnFocus={returnFocus}
      initialFocus={action.fields ? "input" : "[data-cancel]"}
      onClose={onClose}
      onSubmit={() => {
        if (valid && !busy && connected)
          void onSubmit(value.trim(), remote.trim());
      }}
      footer={
        <>
          <button
            className="btn"
            type="button"
            disabled={busy}
            onClick={onClose}
            data-cancel
          >
            {t("Cancel")}
          </button>
          <button
            className="btn"
            data-variant={action.danger ? "danger" : "primary"}
            disabled={busy || !valid || !connected}
          >
            {busy ? (
              <LoaderCircle size={15} className="git-spinner" />
            ) : (
              !action.danger && <ArrowRight size={15} />
            )}
            {busy ? t("Working…") : t(action.label)}
          </button>
        </>
      }
    >
      {action.fields === "remote" && (
        <label className="git-field">
          {t("Remote name")}
          <input
            value={remote}
            onChange={(event) => setRemote(event.target.value)}
            placeholder={t("origin")}
            required
            disabled={busy}
          />
        </label>
      )}
      {action.fields && (
        <label className="git-field">
          {action.fields === "branch"
            ? t("Branch name")
            : action.fields === "stash"
              ? t("Description (optional)")
              : t("Repository URL")}
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={
              action.fields === "branch"
                ? t("feature/my-change")
                : action.fields === "stash"
                  ? t("Work in progress")
                  : t("git@github.com:owner/repository.git")
            }
            required={action.fields !== "stash"}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      )}
      {!connected && <p role="alert">{t("Reconnect to Citropy before continuing.")}</p>}
      {error && (
        <div className="git-dialog-error" role="alert">
          <strong>{error}</strong>
          {errorDetail && (
            <details>
              <summary>{t("Show Git details")}</summary>
              <pre>{errorDetail}</pre>
            </details>
          )}
        </div>
      )}
    </Modal>
  );
}
