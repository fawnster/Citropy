import { useEffect, useState } from "react";
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
} from "lucide-react";
import { ProjectSettings } from "./ProjectSettings.tsx";
import { SkillsSettings } from "./SkillsSettings.tsx";
import { BrowserProfiles } from "./BrowserProfiles.tsx";
import { DiagnosticsSettings } from "./DiagnosticsSettings.tsx";
import { ComputerSettings } from "./ComputerSettings.tsx";
import { ProviderSettings } from "./ProviderSettings.tsx";
import { SectionSidebar } from "./SectionSidebar.tsx";
import {
  setTheme,
  setUiScale,
  setTextStreaming,
  setTypingAnimation,
  setTypingSpeed,
  toggleSidebar,
  toggleInspector,
  useApp,
  viewportWidth,
  confirmAction,
} from "../lib/store.ts";
import { send } from "../lib/socket.ts";
import type { DesktopWindowState } from "../desktop.d.ts";

const sections = [
  {
    name: "General",
    icon: SlidersHorizontal,
    description: "Set up your conversation workspace.",
  },
  {
    name: "Appearance",
    icon: Palette,
    description: "Choose how Citropy looks.",
  },
  {
    name: "Projects",
    icon: FolderCog,
    description: "Set project defaults, worktrees, and terminal actions.",
  },
  {
    name: "Skills",
    icon: BookOpen,
    description: "Browse and manage the skills available to your providers.",
  },
  {
    name: "Browser",
    icon: Globe,
    description: "Manage browser profiles, saved logins, and site data.",
  },
  { name: "Computer use", icon: Monitor, description: "Share screens and control native desktop applications." },
  {
    name: "Resources",
    icon: Activity,
    description: "Inspect memory, processor use, and running processes.",
  },
  {
    name: "Providers",
    icon: Workflow,
    description: "Choose which providers you use in Citropy.",
  },
  {
    name: "Notifications",
    icon: Bell,
    description: "Choose how Citropy lets you know when work is done.",
  },
  {
    name: "Application",
    icon: Monitor,
    description: "Manage the desktop app and live updates.",
  },
];

export function Settings({
  sidebarOpen,
  onCloseSidebar,
  onBack,
  initialSection = "General",
}: {
  sidebarOpen: boolean;
  onCloseSidebar: () => void;
  onBack: () => void;
  initialSection?: string;
}) {
  const [section, setSection] = useState(initialSection);
  const uiScale = useApp((state) => state.uiScale);
  const theme = useApp((state) => state.theme);
  const sidebar = useApp((state) => state.sidebarOpen);
  const inspector = useApp((state) => state.inspectorOpen);
  const connected = useApp((state) => state.connected);
  const textStreaming = useApp((state) => state.textStreaming);
  const typingAnimation = useApp((state) => state.typingAnimation);
  const typingSpeed = useApp((state) => state.typingSpeed);

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
  const applicationAction = async (
    action: "reload" | "restart" | "development",
  ) => {
    setApplicationError("");
    if (
      action === "restart" &&
      !(await confirmAction({
        title: "Restart Citropy desktop?",
        description:
          "Browser pages will reload. Your conversations and terminals keep running on the local server.",
        label: "Restart desktop",
      }))
    )
      return;
    setUpdating(true);
    try {
      if (action === "development") {
        const response = await fetch("/api/desktop?development=1", {
          method: "POST",
        });
        if (!response.ok) throw new Error(await response.text());
      } else await window.citropyDesktop?.windowCommand(action);
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
    <section className="section-view" aria-label="Settings">
      {sidebarOpen && (
        <SectionSidebar title="Settings" onBack={onBack}>
          {sections.map(({ name, icon: Icon }) => (
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
              <span>{name}</span>
            </button>
          ))}
        </SectionSidebar>
      )}
      <div className="settings scroll">
        <div className="settings-inner">
          <header className="settings-heading">
            <div>
              <h1
                className="settings-title"
                data-settings-section={section.toLowerCase()}
              >
                <SectionIcon size={25} aria-hidden="true" />
                {section}
              </h1>
              <p>{selectedSection.description}</p>
            </div>
            {section === "Providers" && (
              <button
                className="btn"
                disabled={!connected}
                onClick={() => send({ t: "providers.refresh" })}
              >
                <RefreshCw size={14} />
                Refresh models
              </button>
            )}
          </header>
          {section === "Projects" && <ProjectSettings onRun={onBack} />}
          {section === "Skills" && <SkillsSettings />}
          {section === "Browser" && <BrowserProfiles />}
          {section === "Computer use" && <ComputerSettings />}
          {section === "Resources" && <DiagnosticsSettings />}
          {section === "General" && (
            <>
              <h2 className="settings-group-heading">Layout</h2>
              <div className="settings-group">
                <label className="setting-row">
                  <span>
                    <strong>Conversation sidebar</strong>
                    <small>Keep your conversations alongside the chat.</small>
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
                    <strong>Inspector</strong>
                    <small>
                      Show changes, files, and the terminal next to your chat.
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
              <p className="settings-note">
                Layout preferences are saved on this device.
              </p>
              <h2 className="settings-group-heading settings-group-spaced">
                Response text
              </h2>
              <div className="settings-group">
                <label className="setting-row">
                  <span>
                    <strong>Text streaming</strong>
                    <small>
                      Show text as it arrives. Turn off to wait for each text
                      block to finish.
                    </small>
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
                    <strong>Typing animation</strong>
                    <small>
                      Reveal finished text gradually. Available when text
                      streaming is off.
                    </small>
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
                    <label htmlFor="typing-speed">Typing speed</label>
                    <output htmlFor="typing-speed">
                      {typingSpeed} characters / second
                    </output>
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
                    <span>Slower</span>
                    <span>Faster</span>
                  </div>
                </div>
              </div>
              <p className="settings-note">
                Tool activity stays live. Saved conversations appear
                immediately. Typing animation respects your system’s
                reduced-motion setting.
              </p>
            </>
          )}
          {section === "Notifications" && (
            <>
              <h2 className="settings-group-heading">Completion alerts</h2>
              <div className="settings-group">
                {(
                  [
                    {
                      key: "toasts",
                      label: "In-app notifications",
                      detail:
                        "Show a brief popup when a response or Git action finishes.",
                    },
                    {
                      key: "desktop",
                      label: "Desktop notifications",
                      detail:
                        "Notify you when the Citropy window is in the background.",
                    },
                    {
                      key: "sound",
                      label: "Notification sound",
                      detail:
                        "Use your system sound for desktop notifications.",
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
              <p className="settings-note">
                Your last 100 notifications stay in the notification center
                until you clear them. Desktop alerts require Citropy desktop and
                follow your system's notification settings.
              </p>
            </>
          )}
          {section === "Application" && (
            <>
              <div className="application-identity">
                <span>
                  <Monitor size={24} />
                </span>
                <div>
                  <h2>Citropy desktop</h2>
                  <p>
                    {desktop
                      ? `Version ${desktop.version} · Electron ${desktop.electron}`
                      : "Open the desktop app to use the embedded browser and window controls."}
                  </p>
                </div>
              </div>
              <h2 className="settings-group-heading">Updates and restart</h2>
              <div className="settings-group">
                <div className="setting-row">
                  <span>
                    <strong>Live interface updates</strong>
                    <small>
                      {desktop?.development
                        ? "Connected. Interface changes appear as you save."
                        : "Enable live updates while developing Citropy."}
                    </small>
                  </span>
                  <button
                    type="button"
                    className="btn"
                    disabled={
                      !connected || updating || desktop?.development || running
                    }
                    onClick={() => void applicationAction("development")}
                  >
                    <RefreshCw size={14} />
                    {desktop?.development
                      ? "Live updates on"
                      : "Enable live updates"}
                  </button>
                </div>
                {desktop ? (
                  <>
                    <div className="setting-row">
                      <span>
                        <strong>Reload interface</strong>
                        <small>
                          Refresh the window while conversations and terminals
                          keep running.
                        </small>
                      </span>
                      <button
                        type="button"
                        className="btn"
                        disabled={updating}
                        onClick={() => void applicationAction("reload")}
                      >
                        <RefreshCw size={14} />
                        Reload
                      </button>
                    </div>
                    <div className="setting-row">
                      <span>
                        <strong>Restart desktop</strong>
                        <small>
                          {running
                            ? "Available when active conversations have finished."
                            : "Apply desktop changes and reopen your browser tabs."}
                        </small>
                      </span>
                      <button
                        type="button"
                        className="btn"
                        disabled={!connected || updating || running}
                        onClick={() => void applicationAction("restart")}
                      >
                        <RotateCcw size={14} />
                        Restart
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="setting-row">
                    <span>
                      <strong>Desktop app</strong>
                      <small>
                        Use native browsing, notifications, and window controls.
                      </small>
                    </span>
                    <button
                      type="button"
                      className="btn"
                      disabled={!connected}
                      onClick={() => send({ t: "desktop.open" })}
                    >
                      <ExternalLink size={14} />
                      Open desktop
                    </button>
                  </div>
                )}
              </div>
              {applicationError && (
                <p className="dialog-error" role="alert">
                  {applicationError}
                </p>
              )}
              <p className="settings-note">
                Interface edits update live. Restart the desktop after changing
                its native code. Server changes require restarting the local
                server after active work has finished.
              </p>
            </>
          )}
          {section === "Appearance" && (
            <>
              <h2 className="settings-group-heading">Interface size</h2>
              <div className="settings-group size-setting">
                <div className="size-setting-heading">
                  <div>
                    <label htmlFor="ui-scale">UI size</label>
                    <p>Scale text, icons, and controls together.</p>
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
                  aria-valuetext={`${uiScale} percent`}
                  onChange={(event) => setUiScale(Number(event.target.value))}
                />
                <div className="size-setting-labels">
                  <span>Compact</span>
                  <button
                    type="button"
                    onClick={() => setUiScale(120)}
                    disabled={uiScale === 120}
                  >
                    Reset to 120%
                  </button>
                  <span>Larger</span>
                </div>
              </div>
              <h2 className="settings-group-heading">Theme</h2>
              <div
                className="theme-options"
                role="group"
                aria-label="Color theme"
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
                      <span>{value === "dark" ? "Dark" : "Light"}</span>
                      {theme === value && <Check size={16} />}
                    </span>
                  </button>
                ))}
              </div>
              <p className="settings-note">
                {theme === "dark"
                  ? "Charcoal surfaces with white accents."
                  : "Neutral surfaces with dark accents."}
              </p>
            </>
          )}
          {section === "Providers" && <ProviderSettings />}
        </div>
      </div>
    </section>
  );
}
