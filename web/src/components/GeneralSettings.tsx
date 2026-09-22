import { ExperimentalTag } from "./ExperimentalTag.tsx";
import { useI18n } from "../lib/i18n.ts";
import {
  setLanguage,
  setShowGitHubIdentity,
  setTextStreaming,
  setTypingAnimation,
  setTypingSpeed,
  toggleInspector,
  toggleSidebar,
  useApp,
} from "../lib/store.ts";

export function GeneralSettings() {
  const t = useI18n();
  const language = useApp((state) => state.language);
  const sidebar = useApp((state) => state.sidebarOpen);
  const inspector = useApp((state) => state.inspectorOpen);
  const textStreaming = useApp((state) => state.textStreaming);
  const typingAnimation = useApp((state) => state.typingAnimation);
  const typingSpeed = useApp((state) => state.typingSpeed);
  const showGitHubIdentity = useApp((state) => state.showGitHubIdentity);

  return (
    <>
      <div className="settings-group">
        <label className="setting-row">
          <span>
            <strong>{t("Language")} <ExperimentalTag /></strong>
            <small>{t("Choose the language used in Citropy.")}</small>
          </span>
          <select value={language} onChange={(event) => setLanguage(event.target.value as "en" | "es")}>
            <option value="en">English</option>
            <option value="es">Español</option>
          </select>
        </label>
      </div>
      <h2 className="settings-group-heading">{t("Layout")}</h2>
      <div className="settings-group">
        <label className="setting-row">
          <span>
            <strong>{t("Conversation sidebar")}</strong>
            <small>{t("Keep your conversations alongside the chat.")}</small>
          </span>
          <input
            className="setting-switch"
            type="checkbox"
            role="switch"
            checked={sidebar}
            onChange={toggleSidebar}
          />
        </label>
        <label className="setting-row">
          <span>
            <strong>{t("Inspector")}</strong>
            <small>
              {t("Show changes, files, and the terminal next to your chat.")}
            </small>
          </span>
          <input
            className="setting-switch"
            type="checkbox"
            role="switch"
            checked={inspector}
            onChange={toggleInspector}
          />
        </label>
      </div>
      <p className="settings-note">{" "}{t("Layout preferences are saved on this device.")}{" "}</p>
      <h2 className="settings-group-heading settings-group-spaced">{" "}{t("Chat identity")}{" "}</h2>
      <div className="settings-group">
        <label className="setting-row">
          <span>
            <strong>{t("Use GitHub profile in chat")}</strong>
            <small>{" "}{t("Show your connected GitHub username and photo on your messages. Turn off to show “You” and a generic avatar.")}{" "}</small>
          </span>
          <input
            className="setting-switch"
            type="checkbox"
            role="switch"
            checked={showGitHubIdentity}
            onChange={(event) => setShowGitHubIdentity(event.target.checked)}
          />
        </label>
      </div>
      <h2 className="settings-group-heading settings-group-spaced">{" "}{t("Response text")}{" "}</h2>
      <div className="settings-group">
        <label className="setting-row">
          <span>
            <strong>{t("Text streaming")}</strong>
            <small>{" "}{t("Show text as it arrives. Turn off to wait for each text block to finish.")}{" "}</small>
          </span>
          <input
            className="setting-switch"
            type="checkbox"
            role="switch"
            checked={textStreaming}
            onChange={(event) => setTextStreaming(event.target.checked)}
          />
        </label>
        <label className="setting-row" data-disabled={textStreaming}>
          <span>
            <strong>{t("Typing animation")}</strong>
            <small>{" "}{t("Reveal finished text gradually. Available when text streaming is off.")}{" "}</small>
          </span>
          <input
            className="setting-switch"
            type="checkbox"
            role="switch"
            disabled={textStreaming}
            checked={typingAnimation}
            onChange={(event) =>
              setTypingAnimation(event.target.checked)
            }
          />
        </label>
        <div
          className="typing-speed-setting"
          data-disabled={textStreaming || !typingAnimation}
        >
          <div>
            <label htmlFor="typing-speed">{t("Typing speed")}</label>
            <output htmlFor="typing-speed">
              {typingSpeed}{" "}{t("characters / second")}{" "}</output>
          </div>
          <input
            id="typing-speed"
            type="range"
            min={20}
            max={300}
            step={10}
            value={typingSpeed}
            disabled={textStreaming || !typingAnimation}
            onChange={(event) =>
              setTypingSpeed(Number(event.target.value))
            }
          />
          <div className="typing-speed-labels">
            <span>{t("Slower")}</span>
            <span>{t("Faster")}</span>
          </div>
        </div>
      </div>
      <p className="settings-note">{" "}{t("Tool activity stays live. Saved conversations appear immediately. Typing animation respects your system’s reduced-motion setting.")}{" "}</p>
    </>
  );
}
