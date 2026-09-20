import { useEffect, useState } from "react";
import type { AppUpdateState } from "../../../shared/app-update.ts";
import type { DesktopWindowState } from "../desktop.d.ts";
import { useI18n } from "../lib/i18n.ts";
import { confirmAction } from "../lib/store.ts";

export function ChannelSwitch() {
  const t = useI18n();
  const [desktop, setDesktop] = useState<DesktopWindowState>();
  const [update, setUpdate] = useState<AppUpdateState>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    const off = window.citropyDesktop?.onUpdateState?.((value) => {
      if (alive) setUpdate(value);
    });
    void window.citropyDesktop
      ?.windowState?.()
      .then((value) => {
        if (alive) setDesktop(value);
      })
      .catch(() => {});
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  if (!desktop?.switchable) return null;
  const target = desktop.channel === "lime" ? "stable" : "lime";
  const label = target === "lime" ? t("Use the Lime build") : t("Use the stable build");
  const switching =
    update?.status === "installing" && /build and reopening/.test(update.message ?? "");
  const switchChannel = async () => {
    if (
      !(await confirmAction({
        title: label,
        description:
          target === "lime"
            ? t("Citropy downloads the Lime build from main, replaces this app, and reopens it. Your conversations, settings, and terminals stay.")
            : t("Citropy downloads the latest release, replaces this app, and reopens it. Your conversations, settings, and terminals stay."),
        label: t("Switch and reopen"),
      }))
    )
      return;
    setError(undefined);
    try {
      await window.citropyDesktop?.updateCommand({ action: "switch", channel: target });
    } catch (reason) {
      setError(
        reason instanceof Error && /channel|already on/i.test(reason.message)
          ? reason.message
          : "The desktop update service did not respond. Try again.",
      );
    }
  };
  const channelNote =
    desktop.channel === "lime"
      ? "Lime, the rolling build from main. Switching replaces this app and keeps your data."
      : "Stable releases. Switching to Lime replaces this app and keeps your data.";
  const note =
    error ??
    (update?.status === "error" && /channel/i.test(update.message ?? "") ? update.message : undefined) ??
    channelNote;
  return (
    <div className="setting-row">
      <span>
        <strong>{t("Release channel")}</strong>
        <small>{t(note)}</small>
      </span>
      <button
        type="button"
        className="btn"
        disabled={Boolean(switching)}
        onClick={() => void switchChannel()}
      >
        {switching ? t("Switching…") : label}
      </button>
    </div>
  );
}
