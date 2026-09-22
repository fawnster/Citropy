import { useRef } from "react";
import { useI18n } from "../lib/i18n.ts";
import { send } from "../lib/socket.ts";
import { setUiAlertSounds, setUiSoundVolume, setUiSounds, useApp } from "../lib/store.ts";
import { configureUiSounds, playUiSound, previewUiSound } from "../lib/ui-sound.ts";

export function NotificationSettings() {
  const t = useI18n();
  const connected = useApp((state) => state.connected);
  const notificationPreferences = useApp((state) => state.notificationPreferences);
  const uiSounds = useApp((state) => state.uiSounds);
  const uiAlertSounds = useApp((state) => state.uiAlertSounds);
  const uiSoundVolume = useApp((state) => state.uiSoundVolume);
  const volumePreview = useRef(0);

  return (
    <>
      <h2 className="settings-group-heading">{t("Completion alerts")}</h2>
      <div className="settings-group">
        {(
          [
            {
              key: "toasts",
              label: t("In-app notifications"),
              detail: t(
                "Show a brief popup when a response or Git action finishes.",
              ),
            },
            {
              key: "desktop",
              label: t("Desktop notifications"),
              detail: t(
                "Notify you when the Citropy window is in the background.",
              ),
            },
            {
              key: "sound",
              label: t("Notification sound"),
              detail:
                t("Use your system sound for desktop notifications."),
            },
            {
              key: "subagents",
              label: t("Subagent completions"),
              detail: t(
                "Notify you when a subagent finishes or fails. Results remain available in the conversation.",
              ),
            },
          ] as const
        ).map(({ key, label, detail }) => (
          <label key={key} className="setting-row">
            <span>
              <strong>{label}</strong>
              <small>{detail}</small>
            </span>
            <input
              className="setting-switch"
              type="checkbox"
              role="switch"
              checked={notificationPreferences[key]}
              disabled={!connected}
              onChange={(event) =>
                send({
                  t: "notifications.configure",
                  preferences: { [key]: event.target.checked },
                })
              }
            />
          </label>
        ))}
      </div>
      <p className="settings-note">{" "}{t("Your last 100 notifications stay in the notification center until you clear them. Desktop alerts require Citropy desktop and follow your system's notification settings.")}{" "}</p>
      <h2 className="settings-group-heading settings-group-spaced">{t("Sounds")}</h2>
      <div className="settings-group">
        <label className="setting-row">
          <span>
            <strong>{t("Interface sounds")}</strong>
            <small>{" "}{t("A quiet click when you press a button, a switch, or a tab.")}{" "}</small>
          </span>
          <span className="sound-row-controls">
            <button
              className="btn btn-sm"
              type="button"
              data-ui-sound="off"
              onClick={() => void previewUiSound("click")}
            >{t("Preview")}</button>
            <input
              className="setting-switch"
              type="checkbox"
              role="switch"
              checked={uiSounds}
              onChange={(event) => setUiSounds(event.target.checked)}
            />
          </span>
        </label>
        <label className="setting-row">
          <span>
            <strong>{t("Alert sounds")}</strong>
            <small>{" "}{t("A short chime when an agent finishes or needs your answer.")}{" "}</small>
          </span>
          <span className="sound-row-controls">
            <button
              className="btn btn-sm"
              type="button"
              data-ui-sound="off"
              onClick={() => void previewUiSound("done")}
            >{t("Preview")}</button>
            <input
              className="setting-switch"
              type="checkbox"
              role="switch"
              checked={uiAlertSounds}
              onChange={(event) => setUiAlertSounds(event.target.checked)}
            />
          </span>
        </label>
        <div className="sound-volume">
          <div className="sound-volume-heading">
            <label htmlFor="sound-volume">{t("Volume")}</label>
            <output htmlFor="sound-volume">{uiSoundVolume}%</output>
          </div>
          <input
            id="sound-volume"
            type="range"
            min="0"
            max="100"
            step="5"
            value={uiSoundVolume}
            aria-valuetext={t("{value} percent", { value: uiSoundVolume })}
            onChange={(event) => {
              const volume = Number(event.target.value);
              setUiSoundVolume(volume);
              const now = Date.now();
              if (!uiSounds || now - volumePreview.current < 150) return;
              volumePreview.current = now;
              configureUiSounds({ volume, interfaceSounds: uiSounds, alertSounds: uiAlertSounds });
              playUiSound("click");
            }}
          />
        </div>
      </div>
      <p className="settings-note">{" "}{t("The notification sound above comes from your system. These sounds play inside the Citropy window.")}{" "}</p>
    </>
  );
}
