import { useEffect, useState } from "react";
import { ExternalLink, Monitor, RefreshCw, RotateCcw } from "lucide-react";
import type { AppUpdateState } from "../../../shared/app-update.ts";
import type { DesktopWindowState } from "../desktop.d.ts";
import { isRemote } from "../lib/environment.ts";
import { useI18n } from "../lib/i18n.ts";
import { send } from "../lib/socket.ts";
import { confirmAction, useApp } from "../lib/store.ts";
import { AppUpdateControl } from "./AppUpdateControl.tsx";

export function ApplicationSettings({ active }: { active: boolean }) {
  const t = useI18n();
  const connected = useApp((state) => state.connected);
  const running = useApp((state) =>
    Object.values(state.threads).some((thread) => thread.running),
  );
  const [desktop, setDesktop] = useState<DesktopWindowState>();
  const [update, setUpdate] = useState<AppUpdateState>();
  const [applicationError, setApplicationError] = useState("");
  const [updating, setUpdating] = useState(false);
  useEffect(() => {
    void window.citropyDesktop?.windowState?.().then(setDesktop);
    return window.citropyDesktop?.onWindowState?.(setDesktop);
  }, []);
  useEffect(() => {
    void window.citropyDesktop?.updateState?.().then(setUpdate).catch(() => {});
    return window.citropyDesktop?.onUpdateState?.(setUpdate);
  }, []);
  const applyingUpdate = Boolean(update && ["downloading", "ready", "installing"].includes(update.status));
  const development = useApp((state) => state.development);
  const restartServer = async () => {
    if (!(await confirmAction({
      title: t("Restart the Citropy server?"),
      description: desktop
        ? t("The server and the desktop window restart and pick up code changes. Browser tabs close. Conversations are saved and terminals keep running.")
        : t("The server restarts and picks up code changes. This page reconnects when it is back. Conversations are saved and terminals keep running."),
      label: t("Restart server"),
    })))
      return;
    setApplicationError("");
    send({ t: "server.restart" });
  };
  const applicationAction = async (
    action: "reload" | "restart",
  ) => {
    setApplicationError("");
    if (
      action === "restart" &&
      !(await confirmAction({
        title: t("Restart Citropy desktop?"),
        description:
          t("Browser pages will reload. Your conversations and terminals keep running on the local server."),
        label: t("Restart desktop"),
      }))
    )
      return;
    setUpdating(true);
    try {
      await window.citropyDesktop?.windowCommand(action);
    } catch (error) {
      setApplicationError((error as Error).message);
    } finally {
      setUpdating(false);
    }
  };

  if (!active) return null;

  return (
    <>
      <div className="application-identity">
        <span>
          <Monitor size={24} />
        </span>
        <div>
          <h2>{t(development ? "Citropy development" : "Citropy desktop")}</h2>
          <p>
            {desktop
              ? development
                ? t("Version {version} · Electron {electron}", { version: desktop.version, electron: desktop.electron })
                : t("Version {version}", { version: desktop.version })
              : t("Open the desktop app to use the embedded browser and window controls.")}
          </p>
        </div>
      </div>
      <h2 className="settings-group-heading">{t("Updates and restart")}</h2>
      <div className="settings-group">
        <div className="setting-row">
          <span>
            <strong>{t("Citropy updates")}</strong>
            <small>{t("You’ll be notified when an update is available. Download and apply it when you choose.")}</small>
          </span>
          <AppUpdateControl variant="settings" />
        </div>
        {development && !isRemote() && (
          <div className="setting-row">
            <span>
              <strong>{t("Live interface updates")}</strong>
              <small>{t("Interface changes appear as you save. Development data is stored separately.")}</small>
            </span>
            <span>{t("Live updates on")}</span>
          </div>
        )}
        {development && !isRemote() && (
          <div className="setting-row">
            <span>
              <strong>{t("Restart server")}</strong>
              <small>
                {running
                  ? t("Available when active conversations have finished.")
                  : t("Development only. Stops the server and starts a fresh one with your latest code.")}
              </small>
            </span>
            <button
              type="button"
              className="btn"
              disabled={!connected || updating || running}
              onClick={() => void restartServer()}
            >
              <RotateCcw size={14} />
              {t("Restart server")}
            </button>
          </div>
        )}
        {desktop ? (
          <>
            <div className="setting-row">
              <span>
                <strong>{t("Reload interface")}</strong>
                <small>{" "}{t("Refresh the window while conversations and terminals keep running.")}{" "}</small>
              </span>
              <button
                type="button"
                className="btn"
                disabled={updating}
                onClick={() => void applicationAction("reload")}
              >
                <RefreshCw size={14} />{" "}{t("Reload")}{" "}</button>
            </div>
            <div className="setting-row">
              <span>
                <strong>{t("Restart desktop")}</strong>
                <small>
                  {applyingUpdate
                    ? t("Use Restart & apply to install the downloaded update.")
                    : running
                      ? t("Available when active conversations have finished.")
                      : t("Restart the app and reopen your browser tabs.")}
                </small>
              </span>
              <button
                type="button"
                className="btn"
                disabled={!connected || updating || running || applyingUpdate}
                onClick={() => void applicationAction("restart")}
              >
                <RotateCcw size={14} />{" "}{t("Restart")}{" "}</button>
            </div>
          </>
        ) : (
          <div className="setting-row">
            <span>
              <strong>{t("Desktop app")}</strong>
              <small>{" "}{t("Use native browsing, notifications, and window controls.")}{" "}</small>
            </span>
            <button
              type="button"
              className="btn"
              disabled={!connected}
              onClick={() => send({ t: "desktop.open" })}
            >
              <ExternalLink size={14} />{" "}{t("Open desktop")}{" "}</button>
          </div>
        )}
      </div>
      {applicationError && (
        <p className="dialog-error" role="alert">
          {applicationError}
        </p>
      )}
      {development && !isRemote() && <p className="settings-note">{t("Interface edits update live. Restart the desktop after changing its native code. Server changes require restarting the local server after active work has finished.")}</p>}
    </>
  );
}
