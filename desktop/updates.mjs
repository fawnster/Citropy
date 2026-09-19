import { gt, valid } from "semver";

export function createAppUpdater({
  updater,
  version,
  unavailable,
  external,
  emit,
  prepareInstall,
  recoverInstall = async () => {},
}) {
  let state = {
    status: unavailable ? "unsupported" : "idle",
    currentVersion: version,
    message: unavailable,
  };
  let operation;
  let disposed = false;
  let recovering;
  const listeners = [];
  const publish = (patch) => {
    if (disposed) return;
    state = { ...state, ...patch };
    emit({ ...state });
  };
  const fail = async (error, action) => {
    if (disposed || recovering) return;
    if (action === "install") {
      recovering = recoverInstall();
      try {
        await recovering;
      } catch {
        publish({ status: "error", retry: "install", message: "The update was not applied. Close and reopen Citropy to restart its server." });
        recovering = undefined;
        return;
      }
      recovering = undefined;
    }
    const code = String(error?.code || "");
    const detail = String(error?.message || "");
    const message =
      code.includes("SHA512") || detail.includes("checksum")
        ? "The download failed verification. Download a fresh copy to try again."
        : /404|403|401|token|release|not found/i.test(`${code} ${detail}`)
          ? "No release is accessible. Check published Citropy releases and, for private repositories, your GitHub sign-in."
          : action === "install"
            ? error?.userMessage ||
              "The update could not be applied. Citropy has kept the current version."
            : action === "download"
              ? "The download could not finish. Check your connection and try again."
              : "Could not check for updates. Check your connection and try again.";
    publish({ status: "error", retry: action, message });
  };
  const listen = (name, handler) => {
    updater.on(name, handler);
    listeners.push([name, handler]);
  };
  if (!unavailable && !external) {
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;
    updater.disableWebInstaller = true;
    updater.logger = null;
    listen("update-available", (info) => {
      if (!valid(info.version) || !gt(info.version, version)) {
        publish({
          status: "current",
          version: undefined,
          checkedAt: Date.now(),
          message: undefined,
        });
        return;
      }
      publish({
        status: "available",
        version: info.version,
        checkedAt: Date.now(),
        percent: undefined,
        message: undefined,
      });
    });
    listen("update-not-available", () =>
      publish({
        status: "current",
        version: undefined,
        checkedAt: Date.now(),
        message: undefined,
      }),
    );
    listen("download-progress", (progress) => {
      if (state.status !== "downloading") return;
      publish({
        percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)),
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      });
    });
    listen("update-downloaded", (info) => {
      if (state.status !== "downloading" || info.version !== state.version)
        return;
      publish({ status: "ready", percent: 100, message: undefined });
    });
    listen("error", (error) => {
      void fail(error, operation || "check");
    });
  }
  const command = async (action) => {
    if (disposed || unavailable || operation || recovering) return { ...state };
    if (!["check", "download", "install"].includes(action))
      throw new Error("Unknown update action");
    if (
      action === "check" &&
      ["ready", "downloading", "installing"].includes(state.status)
    )
      return { ...state };
    if (
      action === "download" &&
      state.status !== "available" &&
      !(state.status === "error" && state.retry === "download")
    )
      throw new Error("Check for a new release before downloading.");
    if (
      action === "install" &&
      state.status !== "ready" &&
      !(state.status === "error" && state.retry === "install")
    )
      throw new Error("Download and verify the update before applying it.");
    operation = action;
    publish({
      status:
        action === "check"
          ? "checking"
          : action === "download"
            ? "downloading"
            : "installing",
      message: undefined,
      retry: undefined,
      ...(action === "download"
        ? {
            percent: 0,
            transferred: 0,
            total: undefined,
            bytesPerSecond: undefined,
          }
        : {}),
    });
    void (async () => {
      try {
        if (action === "check" && external) {
          const next = await external.check();
          if (!valid(next) || !gt(next, version)) {
            publish({
              status: "current",
              version: undefined,
              checkedAt: Date.now(),
              message: undefined,
            });
          } else {
            publish({
              status: "available",
              version: next,
              checkedAt: Date.now(),
              percent: undefined,
              message: `The installer will download Citropy ${next} and reopen the app.`,
            });
          }
        } else if (action === "check") {
          const result = await updater.checkForUpdates();
          if (!result) throw new Error("No release feed is available");
        } else if (action === "download" && external) {
          publish({
            status: "ready",
            percent: 100,
            message: "Click again to quit Citropy and apply the update. It reopens automatically when the installer finishes.",
          });
        } else if (action === "download") {
          await updater.downloadUpdate();
          if (state.status === "downloading")
            throw new Error("The download did not pass verification");
        } else {
          await prepareInstall();
          if (external) await external.install();
          else updater.quitAndInstall(false, true);
        }
      } catch (error) {
        await fail(error, action);
      } finally {
        operation = undefined;
      }
    })();
    return { ...state };
  };
  const startup = unavailable
    ? undefined
    : setTimeout(() => void command("check"), 5000);
  const interval = unavailable
    ? undefined
    : setInterval(
        () => {
          if (["idle", "current", "available"].includes(state.status))
            void command("check");
        },
        4 * 60 * 60 * 1000,
      );
  startup?.unref();
  interval?.unref();
  return {
    state: () => ({ ...state }),
    command,
    dispose() {
      disposed = true;
      clearTimeout(startup);
      clearInterval(interval);
      for (const [name, listener] of listeners) updater.off(name, listener);
    },
  };
}
