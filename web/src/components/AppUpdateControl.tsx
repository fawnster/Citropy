import { AnimatePresence, motion } from "motion/react";
import { useReducedMotion } from "../lib/use-reduced-motion.ts";
import { useI18n } from "../lib/i18n.ts";
import { useEffect, useId, useRef, useState } from "react";
import {
  Check,
  Download,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import type { AppUpdateState } from "../../../shared/app-update.ts";

const size = (bytes?: number) =>
  bytes ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : "";

export function AppUpdateControl({ variant = "rail" }: { variant?: "rail" | "settings" }) {
  const t = useI18n();
  const reducedMotion = useReducedMotion();
  const [state, setState] = useState<AppUpdateState>({
    status: "unsupported",
    currentVersion: "",
    message:
      "Open the installed Citropy desktop app to manage release updates.",
  });
  const [open, setOpen] = useState(false);
  const id = useId();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const alive = useRef(true);
  const revision = useRef(0);
  useEffect(() => {
    alive.current = true;
    const desktop = window.citropyDesktop;
    let received = false;
    const off = desktop?.onUpdateState?.((value) => {
      received = true;
      revision.current++;
      setState(value);
    });
    void desktop
      ?.updateState?.()
      .then((value) => {
        if (alive.current && !received) setState(value);
      })
      .catch(() => {});
    return () => {
      alive.current = false;
      off?.();
      clearTimeout(timer.current);
    };
  }, []);
  const downloading = state.status === "downloading";
  const busy =
    downloading || state.status === "checking" || state.status === "installing";
  const ready =
    state.status === "ready" ||
    (state.status === "error" && state.retry === "install");
  const action = ready
    ? "install"
    : state.status === "available"
      ? "download"
      : state.retry || "check";
  const label =
    state.status === "installing"
      ? "Applying update…"
      : ready
        ? "Restart & apply"
        : downloading
          ? t("Downloading {percent}%", { percent: Math.floor(state.percent || 0) })
          : state.status === "checking"
            ? "Checking for updates…"
            : state.status === "available"
              ? "Download update"
              : state.status === "error"
                ? "Retry update"
                : "Check for Citropy updates";
  const title =
    state.status === "unsupported"
      ? "Citropy updates"
      : state.status === "current"
        ? "Citropy is up to date"
        : state.status === "available"
          ? t("Citropy {version} is available", { version: state.version ?? "" })
          : ready
            ? "Your update is ready"
            : label;
  const show = () => {
    clearTimeout(timer.current);
    setOpen(true);
  };
  const hide = () => {
    timer.current = setTimeout(() => setOpen(false), 160);
  };
  const run = async () => {
    show();
    if (busy || state.status === "unsupported") return;
    try {
      const before = revision.current;
      const value = await window.citropyDesktop?.updateCommand(action);
      if (value && alive.current && revision.current === before)
        setState(value);
    } catch {
      if (alive.current)
        setState((previous) => ({
          ...previous,
          status: "error",
          retry: action,
          message: "The desktop update service did not respond. Try again.",
        }));
    }
  };
  const Icon =
    state.status === "error"
      ? TriangleAlert
      : busy && !downloading
        ? LoaderCircle
        : ready
          ? RefreshCw
          : state.status === "current"
            ? Check
            : Download;
  return (
    <div
      className={`app-update-control${variant === "settings" ? " app-update-settings" : ""}`}
      onPointerEnter={show}
      onPointerLeave={hide}
      onFocus={show}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) hide();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          clearTimeout(timer.current);
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className={variant === "settings" ? "btn app-update-button" : "rail-action app-update-button"}
        data-state={state.status}
        aria-label={t(label)}
        aria-describedby={open ? id : undefined}
        aria-disabled={busy || state.status === "unsupported"}
        onClick={() => void run()}
      >
        <Icon
          size={17}
          className={busy && !downloading ? "git-spinner" : undefined}
        />
        {variant === "settings" ? t(label) : downloading && <small>{Math.floor(state.percent || 0)}%</small>}
        {variant === "rail" && state.status === "available" && (
          <span className="update-available-dot" />
        )}
      </button>
      <AnimatePresence>{open && (
        <motion.div initial={{ opacity: 0, y: reducedMotion ? 0 : 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reducedMotion ? 0 : 4, pointerEvents: "none" }} transition={{ duration: reducedMotion ? 0 : 0.16 }} className="app-update-popover" id={id} role="tooltip">
          <div className="app-update-heading">
            <Icon size={16} />
            <strong>{t(title)}</strong>
          </div>
          {state.currentVersion && (
            <small>
              {state.version && state.status !== "current"
                ? `${state.currentVersion} → ${state.version}`
                : t("Version {version}", { version: state.currentVersion })}
            </small>
          )}
          {state.message ? (
            <p>{t(state.message)}</p>
          ) : downloading ? (
            <>
              <div className="app-update-progress-label">
                <span>
                  {size(state.transferred)}
                  {state.total ? ` / ${size(state.total)}` : ""}
                </span>
                <strong>{Math.floor(state.percent || 0)}%</strong>
              </div>
              <div
                className="app-update-progress"
                role="progressbar"
                aria-label={t("Update download")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.floor(state.percent || 0)}
              >
                <div style={{ width: `${state.percent || 0}%` }} />
              </div>
              <p>
                {state.bytesPerSecond
                  ? `${size(state.bytesPerSecond)}/s · `
                  : ""}{t("You can keep working while it downloads.")}</p>
            </>
          ) : ready ? (
            <p>{t("Download verified. Click again to restart Citropy and apply it.")}</p>
          ) : state.status === "available" ? (
            <p>{t("Click to download. Citropy will wait for another click before restarting.")}</p>
          ) : state.status === "current" ? (
            <p>{t("No newer release is available.")}</p>
          ) : state.status === "installing" ? (
            <p>{t("Saving your work and restarting Citropy.")}</p>
          ) : (
            <p>{t("Check the latest Citropy release.")}</p>
          )}
        </motion.div>
      )}</AnimatePresence>
    </div>
  );
}
