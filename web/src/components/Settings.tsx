import { Fragment, useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  Bell,
  BookOpen,
  FolderCog,
  Globe,
  Monitor,
  Palette,
  PencilLine,
  RefreshCw,
  SlidersHorizontal,
  Workflow,
} from "lucide-react";
import { isRemote, useEnvironments } from "../lib/environment.ts";
import { useI18n } from "../lib/i18n.ts";
import { send } from "../lib/socket.ts";
import { useApp, viewportWidth } from "../lib/store.ts";
import { AnimatedText } from "./AnimatedText.tsx";
import { AppearanceSettings } from "./AppearanceSettings.tsx";
import { ApplicationSettings } from "./ApplicationSettings.tsx";
import { AssistanceSettings } from "./AssistanceSettings.tsx";
import { BrowserProfiles } from "./BrowserProfiles.tsx";
import { ComputerSettings } from "./ComputerSettings.tsx";
import { DiagnosticsSettings } from "./DiagnosticsSettings.tsx";
import { EnvironmentSettings } from "./EnvironmentSettings.tsx";
import { GeneralSettings } from "./GeneralSettings.tsx";
import { NotificationSettings } from "./NotificationSettings.tsx";
import { ProjectSettings } from "./ProjectSettings.tsx";
import { ProviderSettings } from "./ProviderSettings.tsx";
import { SectionSidebar } from "./SectionSidebar.tsx";
import { SkillsSettings } from "./SkillsSettings.tsx";

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
  const [section, setSection] = useState(initialSection);
  useEffect(() => setSection(initialSection), [initialSection]);
  const connected = useApp((state) => state.connected);

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
        <div className="settings-inner">
          <Fragment key={environment}>
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
            {section === "General" && <GeneralSettings />}
            {section === "Notifications" && <NotificationSettings />}
            {section === "Appearance" && <AppearanceSettings />}
            {section === "Providers" && <ProviderSettings />}
          </Fragment>
          <ApplicationSettings active={section === "Application"} />
        </div>
      </div>
    </section>
  );
}
