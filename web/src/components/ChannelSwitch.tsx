import { useEffect, useState } from "react";
import { useI18n } from "../lib/i18n.ts";
import { confirmAction } from "../lib/store.ts";

export function ChannelSwitch() {
  const t = useI18n();
  const [channel, setChannel] = useState<"stable" | "lemon">();
  const [development, setDevelopment] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void window.citropyDesktop
      ?.windowState?.()
      .then((state) => {
        if (!alive) return;
        setChannel(state.channel ?? "stable");
        setDevelopment(state.development);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  if (!channel || development) return null;
  const target = channel === "lemon" ? "stable" : "lemon";
  const label = target === "lemon" ? t("Use the Lemon build") : t("Use the stable build");
  const switchChannel = async () => {
    if (
      !(await confirmAction({
        title: label,
        description:
          target === "lemon"
            ? t("Citropy downloads the rolling build from main, replaces this app, and reopens it. Your conversations, settings, and terminals stay.")
            : t("Citropy downloads the latest release, replaces this app, and reopens it. Your conversations, settings, and terminals stay."),
        label: t("Switch and reopen"),
      }))
    )
      return;
    setBusy(true);
    try {
      await window.citropyDesktop?.updateCommand({ action: "switch", channel: target });
    } catch {
      setBusy(false);
    }
  };
  return (
    <div className="setting-row">
      <span>
        <strong>{t("Release channel")}</strong>
        <small>
          {channel === "lemon"
            ? t("Lemon, the rolling build from main. Switching replaces this app and keeps your data.")
            : t("Stable releases. Switching to Lemon replaces this app and keeps your data.")}
        </small>
      </span>
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={() => void switchChannel()}
      >
        {busy ? t("Switching…") : label}
      </button>
    </div>
  );
}
