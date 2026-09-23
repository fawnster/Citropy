import { QuestionPanel } from "./components/QuestionPanel.tsx";
import { LinkActions } from "./components/LinkActions.tsx";
import { RemoteConnectionBanner } from "./components/EnvironmentSettings.tsx";
import { environmentStorage, selectEnvironment, useEnvironments } from "./lib/environment.ts";
import { AnimatePresence } from "motion/react";
import { useI18n } from "./lib/i18n.ts";
import { NewConversation } from "./components/NewConversation.tsx";
import {
  Fragment,
  lazy,
  Suspense,
  useEffect,
  useState,
  type CSSProperties,
} from "react";
import { Titlebar } from "./components/Titlebar.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { SidebarFooter } from "./components/SidebarFooter.tsx";
import { Conversation } from "./components/Conversation.tsx";
import { Composer } from "./components/Composer.tsx";
import { Inspector } from "./components/Inspector.tsx";
import { SlidingPanel } from "./components/SlidingPanel.tsx";
import { PermissionPanel } from "./components/PermissionPanel.tsx";
import { Toasts } from "./components/Toasts.tsx";
import { ConfirmationDialog } from "./components/ConfirmationDialog.tsx";
import { RemoteFolderDialog } from "./components/RemoteFolderDialog.tsx";
import type { NotificationTarget } from "../../shared/protocol.ts";
import { Welcome } from "./components/Welcome.tsx";
import {
  useApp,
  viewportWidth,
  selectThread,
  toggleInspector,
  toggleSidebar,
} from "./lib/store.ts";
import { send } from "./lib/socket.ts";
import { useUiSounds } from "./lib/use-ui-sounds.ts";
import { createThread } from "./lib/actions.ts";
import { reportError } from "./lib/api.ts";
import { useGitHub } from "./lib/use-github.ts";

const GitHub = lazy(() =>
  import("./components/github/GitHub.tsx").then((module) => ({
    default: module.GitHub,
  })),
);
const GitManager = lazy(() =>
  import("./components/GitManager.tsx").then((module) => ({
    default: module.GitManager,
  })),
);
const Settings = lazy(() =>
  import("./components/Settings.tsx").then((module) => ({
    default: module.Settings,
  })),
);
const UsageView = lazy(() =>
  import("./components/UsageView.tsx").then((module) => ({
    default: module.UsageView,
  })),
);

export function App() {
  const t = useI18n();
  const { activeId: environment } = useEnvironments();
  const view = useApp((state) => state.activeView);
  const setView = (activeView: typeof view) => useApp.setState({ activeView });
  const [settingsSection, setSettingsSection] = useState("General");
  const [gitBusy, setGitBusy] = useState(false);
  const [sectionSidebarOpen, setSectionSidebarOpen] = useState(
    viewportWidth() > 720,
  );
  const newThreadProvider = useApp((state) => state.newThreadProvider);
  const language = useApp((state) => state.language);
  const sidebarOpen = useApp((state) => state.sidebarOpen);
  const inspectorOpen = useApp((state) => state.inspectorOpen);
  const panelWidths = useApp((state) => state.panelWidths);
  const uiScale = useApp((state) => state.uiScale);
  const activeThreadId = useApp((state) => state.activeThreadId);
  const activeProjectId = useApp((state) => state.activeProjectId);
  const githubStatus = useGitHub("status", {
    projectId: activeProjectId ?? undefined,
  });
  const threadOrder = useApp((state) => state.threadOrder);
  const threads = useApp((state) => state.threads);
  const hasProject = useApp((state) => state.projects.length > 0);
  const navigationOpen = view === "chat" ? sidebarOpen : sectionSidebarOpen;
  useUiSounds();

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    const update = () => document.documentElement.toggleAttribute("data-page-hidden", document.hidden);
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      document.documentElement.removeAttribute("data-page-hidden");
    };
  }, []);

  const openView = (next: typeof view) => {
    if (next !== "chat") useApp.setState({ readingThreadId: null });
    setView(next);
    if (next === "chat") {
      if (viewportWidth() <= 720 && useApp.getState().sidebarOpen)
        toggleSidebar();
    } else {
      setSectionSidebarOpen(viewportWidth() > 720);
    }
  };
  const toggleNavigation = () => {
    if (view === "chat") toggleSidebar();
    else setSectionSidebarOpen((open) => !open);
  };
  const navigation = (
    <SidebarFooter
      activeView={view}
      onGit={() => openView("git")}
      onGitHub={() => openView("github")}
      onSettings={() => {
        setSettingsSection("General");
        openView("settings");
      }}
      onUsage={() => openView("usage")}
    />
  );

  useEffect(() => {
    if (githubStatus.data)
      useApp.setState({ githubAccount: githubStatus.data.account ?? null });
  }, [githubStatus.data]);

  const openNotification = (target: NotificationTarget) => {
    if (target.view === "settings") setSettingsSection(target.section ?? "General");
    const state = useApp.getState();
    if (
      target.projectId &&
      state.projects.some((project) => project.id === target.projectId)
    ) {
      useApp.setState({ activeProjectId: target.projectId });
      environmentStorage.setItem("citropy.project", target.projectId);
    }
    if (target.threadId && state.threads[target.threadId])
      selectThread(target.threadId);
    openView(target.view);
  };

  useEffect(
    () =>
      window.citropyDesktop?.onNotification?.((notification) => {
        void (async () => {
          if (notification.environmentId) await selectEnvironment(notification.environmentId);
          send({ t: "notifications.read", ids: [notification.id] });
          openNotification(notification.target);
        })().catch(reportError);
      }),
    [],
  );

  useEffect(
    () =>
      window.citropyDesktop?.onBrowserSelect((panel) => {
        setView("chat");
        useApp.setState((state) => ({
          activeProjectId: panel.projectId,
          activePanels: { ...state.activePanels, [panel.projectId]: panel.id },
          inspectorOpen: true,
        }));
        if (panel.threadId && useApp.getState().threads[panel.threadId])
          selectThread(panel.threadId);
      }),
    [],
  );

  useEffect(() => {
    if (activeThreadId || !activeProjectId) return;
    const newest = threadOrder.find(
      (id) =>
        threads[id]?.projectId === activeProjectId &&
        !threads[id]?.parentThreadId &&
        !threads[id]?.archived &&
        !threads[id]?.snoozedUntil,
    );
    if (newest) selectThread(newest);
  }, [activeThreadId, activeProjectId, threadOrder, threads]);

  useEffect(() => {
    const refresh = () => send({ t: "providers.refresh" });
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === "b") {
        event.preventDefault();
        if (view === "chat") toggleSidebar();
        else setSectionSidebarOpen((open) => !open);
      } else if (key === "j") {
        event.preventDefault();
        setView("chat");
        toggleInspector();
      } else if (key === "n" && !event.shiftKey) {
        event.preventDefault();
        setView("chat");
        createThread();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view]);

  return (
    <div
      className="shell"
      data-sidebar={navigationOpen}
      data-inspector={inspectorOpen && view === "chat"}
      style={
        Object.fromEntries(
          Object.entries(panelWidths).map(([panel, width]) => [
            `--${panel}-width`,
            `${Math.round((width * uiScale) / 100)}px`,
          ]),
        ) as CSSProperties
      }
    >
      <Titlebar
        key={environment}
        onNotification={openNotification}
        view={view}
        sidebarOpen={navigationOpen}
        workspaceDisabled={view === "git" && gitBusy}
        onToggleSidebar={toggleNavigation}
      />
      <RemoteConnectionBanner />
      <div className="shell-body">
        {navigationOpen && (
          <button
            className="sidebar-scrim"
            type="button"
            aria-label={t("Close navigation")}
            onClick={toggleNavigation}
          />
        )}
        {view === "chat" && <SlidingPanel open={sidebarOpen} side="left">
          <Sidebar
            key={environment}
            onSettings={() => {
              setSettingsSection("General");
              openView("settings");
            }}
            onUsage={() => openView("usage")}
            onGit={() => openView("git")}
            onGitHub={() => openView("github")}
            onConversation={() => openView("chat")}
          />
        </SlidingPanel>}
        <main className="stage">
          <Suspense
            fallback={
              <div className="pane-empty" role="status">{t("Loading…")}</div>
            }
          >
            {view === "usage" ? (
              <UsageView
                key={environment}
                navigation={navigation}
                sidebarOpen={sectionSidebarOpen}
                onBack={() => openView("chat")}
              />
            ) : view === "git" ? (
              <GitManager
                navigation={navigation}
                onBusyChange={setGitBusy}
                key={`${environment}:${activeProjectId}:${activeThreadId}`}
                sidebarOpen={sectionSidebarOpen}
                onCloseSidebar={() => setSectionSidebarOpen(false)}
                onBack={() => openView("chat")}
              />
            ) : view === "github" ? (
              <GitHub
                navigation={navigation}
                status={githubStatus}
                onGit={() => openView("git")}
                key={`${environment}:${activeProjectId}`}
                sidebarOpen={sectionSidebarOpen}
                onCloseSidebar={() => setSectionSidebarOpen(false)}
                onBack={() => openView("chat")}
              />
            ) : view === "settings" ? (
              <Settings
                navigation={navigation}
                initialSection={settingsSection}
                sidebarOpen={sectionSidebarOpen}
                onCloseSidebar={() => setSectionSidebarOpen(false)}
                onBack={() => openView("chat")}
              />
            ) : hasProject && activeThreadId ? (
              <Fragment key={`${environment}:${activeThreadId}`}>
                <Conversation />
                <QuestionPanel />
                <PermissionPanel />
                <Composer
                  onUsage={() => openView("usage")}
                  onSkills={() => {
                    setSettingsSection("Skills");
                    openView("settings");
                  }}
                />
              </Fragment>
            ) : (
              <Welcome key={environment} />
            )}
          </Suspense>
        </main>
        {hasProject && <SlidingPanel open={inspectorOpen && view === "chat"} side="right" keepMounted>
          <Inspector key={environment} visible={inspectorOpen && view === "chat"} />
        </SlidingPanel>}
      </div>
      <AnimatePresence>{newThreadProvider && (
        <NewConversation key={`${environment}:${activeProjectId}:${newThreadProvider}`} />
      )}</AnimatePresence>
      <ConfirmationDialog />
      <RemoteFolderDialog />
      <LinkActions />
      <Toasts onOpen={openNotification} />
    </div>
  );
}
