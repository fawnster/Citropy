import { NewConversation } from "./components/NewConversation.tsx";
import { lazy, Suspense, useEffect, useState, type CSSProperties } from "react";
import { Titlebar } from "./components/Titlebar.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { Conversation } from "./components/Conversation.tsx";
import { Composer } from "./components/Composer.tsx";
import { Inspector } from "./components/Inspector.tsx";
import { PermissionLayer } from "./components/PermissionLayer.tsx";
import { Toasts } from "./components/Toasts.tsx";
import { ConfirmationDialog } from "./components/ConfirmationDialog.tsx";
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
import { createThread } from "./lib/actions.ts";

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
  const [view, setView] = useState<
    "chat" | "git" | "github" | "settings" | "usage"
  >("chat");
  const [settingsSection, setSettingsSection] = useState("General");
  const [sectionSidebarOpen, setSectionSidebarOpen] = useState(
    viewportWidth() > 720,
  );
  const newThreadProvider = useApp((state) => state.newThreadProvider);
  const sidebarOpen = useApp((state) => state.sidebarOpen);
  const inspectorOpen = useApp((state) => state.inspectorOpen);
  const panelWidths = useApp((state) => state.panelWidths);
  const activeThreadId = useApp((state) => state.activeThreadId);
  const activeProjectId = useApp((state) => state.activeProjectId);
  const threadOrder = useApp((state) => state.threadOrder);
  const threads = useApp((state) => state.threads);
  const hasProject = useApp((state) => state.projects.length > 0);
  const navigationOpen = view === "chat" ? sidebarOpen : sectionSidebarOpen;

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

  const openNotification = (target: NotificationTarget) => {
    const state = useApp.getState();
    if (
      target.projectId &&
      state.projects.some((project) => project.id === target.projectId)
    ) {
      useApp.setState({ activeProjectId: target.projectId });
      localStorage.setItem("citropy.project", target.projectId);
    }
    if (target.threadId && state.threads[target.threadId])
      selectThread(target.threadId);
    openView(target.view);
  };

  useEffect(
    () =>
      window.citropyDesktop?.onNotification?.((notification) => {
        send({ t: "notifications.read", ids: [notification.id] });
        openNotification(notification.target);
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
            `${width}px`,
          ]),
        ) as CSSProperties
      }
    >
      <Titlebar
        onNotification={openNotification}
        view={view}
        sidebarOpen={navigationOpen}
        onToggleSidebar={toggleNavigation}
      />
      <div className="shell-body">
        {navigationOpen && (
          <button
            className="sidebar-scrim"
            type="button"
            aria-label="Close navigation"
            onClick={toggleNavigation}
          />
        )}
        {view === "chat" && sidebarOpen && (
          <Sidebar
            onSettings={() => {
              setSettingsSection("General");
              openView("settings");
            }}
            onUsage={() => openView("usage")}
            onGit={() => openView("git")}
            onGitHub={() => openView("github")}
            onConversation={() => openView("chat")}
          />
        )}
        <main className="stage">
          <Suspense
            fallback={
              <div className="pane-empty" role="status">
                Loading…
              </div>
            }
          >
            {view === "usage" ? (
              <UsageView
                sidebarOpen={sectionSidebarOpen}
                onBack={() => openView("chat")}
              />
            ) : view === "git" ? (
              <GitManager
                key={`${activeProjectId}:${activeThreadId}`}
                sidebarOpen={sectionSidebarOpen}
                onCloseSidebar={() => setSectionSidebarOpen(false)}
                onBack={() => openView("chat")}
              />
            ) : view === "github" ? (
              <GitHub
                onGit={() => openView("git")}
                key={activeProjectId}
                sidebarOpen={sectionSidebarOpen}
                onCloseSidebar={() => setSectionSidebarOpen(false)}
                onBack={() => openView("chat")}
              />
            ) : view === "settings" ? (
              <Settings
                initialSection={settingsSection}
                sidebarOpen={sectionSidebarOpen}
                onCloseSidebar={() => setSectionSidebarOpen(false)}
                onBack={() => openView("chat")}
              />
            ) : hasProject && activeThreadId ? (
              <>
                <Conversation />
                <Composer
                  key={activeThreadId}
                  onUsage={() => openView("usage")}
                  onSkills={() => {
                    setSettingsSection("Skills");
                    openView("settings");
                  }}
                />
              </>
            ) : (
              <Welcome />
            )}
          </Suspense>
        </main>
        {hasProject && <Inspector visible={inspectorOpen && view === "chat"} />}
      </div>
      {newThreadProvider && (
        <NewConversation key={`${activeProjectId}:${newThreadProvider}`} />
      )}
      <PermissionLayer />
      <ConfirmationDialog />
      <Toasts onOpen={openNotification} />
    </div>
  );
}
