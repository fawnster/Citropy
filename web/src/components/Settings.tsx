import { AnimatedText } from "./AnimatedText.tsx";
import { EnvironmentSettings } from "./EnvironmentSettings.tsx";
import { isRemote, useEnvironments } from "../lib/environment.ts";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Check,
  Moon,
  Palette,
  RefreshCw,
  SlidersHorizontal,
  Sun,
  Workflow,
  Bell,
  Monitor,
  RotateCcw,
  ExternalLink,
  BookOpen,
  FolderCog,
  Globe,
  Activity,
  PencilLine,
} from "lucide-react";
import { ProjectSettings } from "./ProjectSettings.tsx";
import { SkillsSettings } from "./SkillsSettings.tsx";
import { BrowserProfiles } from "./BrowserProfiles.tsx";
import { DiagnosticsSettings } from "./DiagnosticsSettings.tsx";
import { ComputerSettings } from "./ComputerSettings.tsx";
import { ProviderSettings } from "./ProviderSettings.tsx";
import { AssistanceSettings } from "./AssistanceSettings.tsx";
import { AppUpdateControl } from "./AppUpdateControl.tsx";
import { ChannelSwitch } from "./ChannelSwitch.tsx";
import { ExperimentalTag } from "./ExperimentalTag.tsx";
import { SectionSidebar } from "./SectionSidebar.tsx";
import {
  setTheme,
  setUiScale,
  setTextStreaming,
  setTypingAnimation,
  setTypingSpeed,
  setUiAlertSounds,
  setUiSoundVolume,
  setUiSounds,
  setShowGitHubIdentity,
  toggleSidebar,
  toggleInspector,
  useApp,
  viewportWidth,
  confirmAction,
  setLanguage,
} from "../lib/store.ts";
import { send } from "../lib/socket.ts";
import { configureUiSounds, playUiSound, previewUiSound } from "../lib/ui-sound.ts";
import { useI18n } from "../lib/i18n.ts";
import type { DesktopWindowState } from "../desktop.d.ts";

const sections = [
  { name: "Environments", group: "Workspace", icon: Monitor, description: "Choose this computer or an SSH host for your workspaces." },
  {
    name: "General",
    group: "Workspace",
    icon: SlidersHorizontal,
    description: "Set up your conversation workspace.",
  },
  {
    name: "Appearance",
    group: "Workspace",
    icon: Palette,
    description: "Choose how Citropy looks.",
  },
  {
    name: "Projects",
    group: "Workspace",
    icon: FolderCog,
    description: "Manage global defaults and folder overrides.",
  },
  {
    name: "Providers",
    group: "Providers & tools",
    icon: Workflow,
    description: "Choose which providers you use in Citropy.",
  },
  {
    name: "Skills",
    group: "Providers & tools",
    icon: BookOpen,
    description: "Browse and manage the skills available to your providers.",
  },
  {
    name: "AI assistance",
    group: "Providers & tools",
    icon: PencilLine,
    description: "Choose models for conversation titles and commit messages.",
  },
  {
    name: "Browser",
    group: "Providers & tools",
    icon: Globe,
    description: "Manage browser profiles, saved logins, and site data.",
  },
  {
    name: "Computer use",
    group: "Providers & tools",
    icon: Monitor,
    description: "Share screens and control native desktop applications.",
  },
  {
    name: "Resources",
    group: "Application",
    icon: Activity,
    description: "Inspect memory, processor use, and running processes.",
  },
  {
    name: "Notifications",
    group: "Workspace",
    icon: Bell,
    description: "Choose how Citropy lets you know when work is done.",
  },
  {
    name: "Application",
    group: "Application",
    icon: Monitor,
    description: "Manage the desktop app and updates.",
  },
];

export function Settings({
  sidebarOpen,
  onCloseSidebar,
  onBack,
  navigation,
  initialSection = "General",
}: {
  sidebarOpen: boolean;
  onCloseSidebar: () => void;
  onBack: () => void;
  navigation?: ReactNode;
  initialSection?: string;
}) {
  const t = useI18n();
  const { activeId: environment } = useEnvironments();
  const language = useApp((state) => state.language);
  const [section, setSection] = useState(initialSection);
  useEffect(() => setSection(initialSection), [initialSection]);
  const uiScale = useApp((state) => state.uiScale);
  const theme = useApp((state) => state.theme);
  const sidebar = useApp((state) => state.sidebarOpen);
  const inspector = useApp((state) => state.inspectorOpen);
  const connected = useApp((state) => state.connected);
  const textStreaming = useApp((state) => state.textStreaming);
  const typingAnimation = useApp((state) => state.typingAnimation);
  const typingSpeed = useApp((state) => state.typingSpeed);
  const showGitHubIdentity = useApp((state) => state.showGitHubIdentity);
  const uiSounds = useApp((state) => state.uiSounds);
  const uiAlertSounds = useApp((state) => state.uiAlertSounds);
  const uiSoundVolume = useApp((state) => state.uiSoundVolume);
  const volumePreview = useRef(0);

  const notificationPreferences = useApp(
    (state) => state.notificationPreferences,
  );
  const running = useApp((state) =>
    Object.values(state.threads).some((thread) => thread.running),
  );
  const [desktop, setDesktop] = useState<DesktopWindowState>();
  const [applicationError, setApplicationError] = useState("");
  const [updating, setUpdating] = useState(false);
  useEffect(() => {
    void window.citropyDesktop?.windowState?.().then(setDesktop);
    return window.citropyDesktop?.onWindowState?.(setDesktop);
  }, []);
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

  const selectedSection =
    sections.find((entry) => entry.name === section) ?? sections[0]!;
  const SectionIcon = selectedSection.icon;

  return (
    <section className="section-view" aria-label={t("Settings")}>
      <SectionSidebar activeItem={section} open={sidebarOpen} title={t("Settings")} onBack={onBack} navigation={navigation}>
          {["Workspace", "Providers & tools", "Application"].map((group) => (
            <Fragment key={group}>
              <h2 className="section-nav-label">{t(group)}</h2>
              {sections.filter((entry) => entry.group === group && (!isRemote() || !["Browser", "Computer use"].includes(entry.name))).map(({ name, icon: Icon }) => (
                <button
                  className="section-link"
                  data-settings-section={name.toLowerCase()}
                  type="button"
                  key={name}
                  aria-current={section === name ? "page" : undefined}
                  onClick={() => {
                    setSection(name);
                    if (viewportWidth() <= 720) onCloseSidebar();
                  }}
                >
                  <Icon size={17} />
                  <span>{t(name)}</span>
                </button>
              ))}
            </Fragment>
          ))}
      </SectionSidebar>
      <div className="settings scroll">
        <div className="settings-inner" key={environment}>
          <header className="settings-heading">
            <div>
              <h1
                className="settings-title"
                data-settings-section={section.toLowerCase()}
              >
                <SectionIcon size={25} aria-hidden="true" />
                <AnimatedText text={t(section)} />
              </h1>
              <p><AnimatedText text={t(selectedSection.description)} /></p>
            </div>
            {section === "Providers" && (
              <button
                className="btn"
                disabled={!connected}
                onClick={() => send({ t: "providers.refresh" })}
              >
                <RefreshCw size={14} />
                {t("Refresh models")}
              </button>
            )}
          </header>
          {section === "Environments" && <EnvironmentSettings />}
          {section === "Projects" && <ProjectSettings />}
          {section === "Skills" && <SkillsSettings />}
          {section === "AI assistance" && <AssistanceSettings />}
          {section === "Browser" && <BrowserProfiles />}
          {section === "Computer use" && <ComputerSettings />}
          {section === "Resources" && <DiagnosticsSettings />}
          {section === "General" && (
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
          )}
          {section === "Notifications" && (
            <>
              <h2 className="settings-group-heading">{t("Completion alerts")}</h2>
              <div className="settings-group">
                {(
                  [
                    {
                      key: "toasts",
                      label: t("In-app notifications"),
                      detail:
                        "Show a brief popup when a response or Git action finishes.",
                    },
                    {
                      key: "desktop",
                      label: t("Desktop notifications"),
                      detail:
                        "Notify you when the Citropy window is in the background.",
                    },
                    {
                      key: "sound",
                      label: t("Notification sound"),
                      detail:
                        t("Use your system sound for desktop notifications."),
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
          )}
          {section === "Application" && (
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
                <ChannelSwitch />
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
                          {running
                            ? t("Available when active conversations have finished.")
                            : t("Restart the app and reopen your browser tabs.")}
                        </small>
                      </span>
                      <button
                        type="button"
                        className="btn"
                        disabled={!connected || updating || running}
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
          )}
          {section === "Appearance" && (
            <>
              <h2 className="settings-group-heading">{t("Interface size")}</h2>
              <div className="settings-group size-setting">
                <div className="size-setting-heading">
                  <div>
                    <label htmlFor="ui-scale">{t("UI size")}</label>
                    <p>{t("Scale text, icons, and controls together.")}</p>
                  </div>
                  <output htmlFor="ui-scale">{uiScale}%</output>
                </div>
                <input
                  id="ui-scale"
                  type="range"
                  min="90"
                  max="150"
                  step="5"
                  value={uiScale}
                  aria-valuetext={t("{value} percent", { value: uiScale })}
                  onChange={(event) => setUiScale(Number(event.target.value))}
                />
                <div className="size-setting-labels">
                  <span>{t("Compact")}</span>
                  <button
                    type="button"
                    onClick={() => setUiScale(120)}
                    disabled={uiScale === 120}
                  >{" "}{t("Reset to 120%")}{" "}</button>
                  <span>{t("Larger")}</span>
                </div>
              </div>
              <h2 className="settings-group-heading">{t("Theme")}</h2>
              <div
                className="theme-options"
                role="group"
                aria-label={t("Color theme")}
              >
                {(["dark", "light"] as const).map((value) => (
                  <button
                    className="theme-option"
                    key={value}
                    type="button"
                    aria-pressed={theme === value}
                    onClick={() => setTheme(value)}
                  >
                    <span
                      className="theme-preview"
                      data-theme={value}
                      aria-hidden="true"
                    >
                      <span className="theme-preview-rail">
                        <i />
                        <i />
                        <i />
                      </span>
                      <span className="theme-preview-chat">
                        <i />
                        <i />
                        <span />
                      </span>
                    </span>
                    <span className="theme-option-label">
                      {value === "dark" ? (
                        <Moon size={16} />
                      ) : (
                        <Sun size={16} />
                      )}
                      <span>{value === "dark" ? t("Dark") : t("Light")}</span>
                      {theme === value && <Check size={16} />}
                    </span>
                  </button>
                ))}
              </div>
              <p className="settings-note">
                {theme === "dark"
                  ? t("Charcoal surfaces with white accents.")
                  : t("Neutral surfaces with dark accents.")}
              </p>
            </>
          )}
          {section === "Providers" && <ProviderSettings />}
        </div>
      </div>
    </section>
  );
}
