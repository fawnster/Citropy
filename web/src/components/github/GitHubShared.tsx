import { Modal } from "../Modal.tsx";
import { useRef, useState, type ReactNode, type FormEvent } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  Circle,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  LoaderCircle,
  X,
} from "lucide-react";
import { useApp } from "../../lib/store.ts";
import { currentLocale, useI18n } from "../../lib/i18n.ts";

export function GitHubLink({
  href,
  children,
  className = "btn",
}: {
  href: string | null | undefined;
  children: ReactNode;
  className?: string;
}) {
  if (!href || !/^https:\/\//i.test(href)) return null;
  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
    >
      {children}
      <ExternalLink size={13} />
    </a>
  );
}

export function GitHubFeedback({
  error,
  loading,
  empty,
}: {
  error?: string;
  loading?: boolean;
  empty?: string;
}) {
  const t = useI18n();
  if (error)
    return (
      <div className="github-feedback" data-error role="alert">
        <AlertCircle size={18} />
        <p>{error}</p>
      </div>
    );
  if (loading)
    return (
      <div className="github-feedback" role="status">
        <LoaderCircle size={18} className="git-spinner" />
        <span>{t("Loading from GitHub…")}</span>
      </div>
    );
  if (empty)
    return (
      <div className="github-empty">
        <Circle size={28} strokeWidth={1.3} />
        <h2>{empty}</h2>
        <p>{t("Try another filter or refresh for updates.")}</p>
      </div>
    );
  return null;
}

export function GitHubState({
  state,
  pull = false,
}: {
  state: string | null;
  pull?: boolean;
}) {
  const t = useI18n();
  const value = (state ?? "pending").toLowerCase();
  const tone = ["merged"].includes(value)
    ? "merged"
    : ["open", "success", "completed", "approved"].includes(value)
      ? "good"
      : [
            "failure",
            "error",
            "timed_out",
            "changes_requested",
            "closed",
          ].includes(value)
        ? "bad"
        : "pending";
  const Icon =
    value === "merged"
      ? GitMerge
      : pull
        ? GitPullRequest
        : tone === "good" && value !== "open"
          ? Check
          : tone === "bad"
            ? X
            : Circle;
  return (
    <span className="github-state" data-tone={tone}>
      <Icon size={15} />
      {t(value.replaceAll("_", " "))}
    </span>
  );
}

export function GitHubPagination({
  page,
  more,
  onChange,
}: {
  page: number;
  more: boolean;
  onChange: (page: number) => void;
}) {
  const t = useI18n();
  if (page === 1 && !more) return null;
  return (
    <div className="github-pagination">
      <button
        className="btn"
        disabled={page === 1}
        onClick={() => onChange(page - 1)}
      >
        <ArrowLeft size={14} />
        {t("Previous")}
      </button>
      <span>{t("Page {page}", { page })}</span>
      <button
        className="btn"
        disabled={!more}
        onClick={() => onChange(page + 1)}
      >
        {t("Next")}
        <ArrowRight size={14} />
      </button>
    </div>
  );
}

export function GitHubDialog({
  title,
  description,
  submitLabel,
  children,
  onSubmit,
  onClose,
  danger = false,
}: {
  title: string;
  description: string;
  submitLabel?: string;
  children?: ReactNode;
  onSubmit?: (data: FormData) => Promise<void>;
  onClose: () => void;
  danger?: boolean;
}) {
  const t = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const connected = useApp((state) => state.connected);
  const submitting = useRef(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!onSubmit || submitting.current || !connected) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await onSubmit(new FormData(event.currentTarget));
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      description={description}
      busy={busy}
      danger={danger}
      className="github-dialog"
      initialFocus="input, textarea, select, [data-cancel]"
      onClose={onClose}
      onSubmit={(event) => void submit(event)}
      footer={
        <>
          <button
            type="button"
            className="btn"
            disabled={busy}
            data-cancel
            onClick={onClose}
          >
            {onSubmit ? t("Cancel") : t("Close")}
          </button>
          {onSubmit && (
            <button
              className="btn"
              data-variant={danger ? "danger" : "primary"}
              disabled={busy || !connected}
            >
              {busy && <LoaderCircle size={14} className="git-spinner" />}
              {busy ? t("Working…") : submitLabel && t(submitLabel)}
            </button>
          )}
        </>
      }
    >
      <fieldset disabled={busy || !connected}>{children}</fieldset>
      <GitHubFeedback error={error} />
      {!connected && (
        <p role="status">
          {t("Reconnecting to Citropy… You can continue when the connection returns.")}
        </p>
      )}
    </Modal>
  );
}

export function githubDate(date: string) {
  return new Intl.DateTimeFormat(currentLocale(), {
    month: "short",
    day: "numeric",
  }).format(new Date(date));
}

export function formText(data: FormData, name: string) {
  return String(data.get(name) ?? "");
}
export function formNames(data: FormData, name: string) {
  return formText(data, name)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}
