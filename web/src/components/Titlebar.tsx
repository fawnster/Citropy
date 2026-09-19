import { GitCommitHorizontal, Server } from "lucide-react";
import { environmentName, isRemote } from "../lib/environment.ts";
import { useI18n } from "../lib/i18n.ts";
import { GitBranch, PanelLeft, PanelRight } from "./icons.ts";
import { toggleInspector, useApp } from "../lib/store.ts";
import { NotificationCenter } from "./NotificationCenter.tsx";
import { ComputerIndicator } from "./ComputerPane.tsx";
import { WindowControls } from "./WindowControls.tsx";
import { GitActions } from "./GitActions.tsx";
import { RunningShells } from "./RunningShells.tsx";
import { WorkspaceSelector } from "./WorkspaceSelector.tsx";
import { ChannelBadge } from "./ChannelBadge.tsx";
import type { NotificationTarget } from "../../../shared/protocol.ts";

export function Titlebar({
  view,
  sidebarOpen,
  workspaceDisabled,
  onToggleSidebar,
  onNotification,
}: {
  view: "chat" | "git" | "github" | "settings" | "usage";
  sidebarOpen: boolean;
  workspaceDisabled: boolean;
  onToggleSidebar: () => void;
  onNotification: (target: NotificationTarget) => void;
}) {
  const t = useI18n();
  const projects = useApp((state) => state.projects);
  const activeProjectId = useApp((state) => state.activeProjectId);
  const activeThreadId = useApp((state) => state.activeThreadId);
  const thread = useApp((state) =>
    activeThreadId ? state.threads[activeThreadId] : undefined,
  );
  const gitThread = useApp(state => {
    let selected = thread;
    const visited = new Set<string>();
    while (selected?.parentThreadId && !visited.has(selected.id)) {
      visited.add(selected.id);
      selected = state.threads[selected.parentThreadId];
    }
    return selected?.parentThreadId ? undefined : selected;
  });
  const git = useApp((state) =>
    activeProjectId ? state.git[activeProjectId] : undefined,
  );
  const inspectorOpen = useApp((state) => state.inspectorOpen);

  const project = projects.find((entry) => entry.id === activeProjectId);

  return (
    <header className="topbar" data-desktop={Boolean(window.citropyDesktop)}>
      <div className="topbar-left">
        <div className="brand">
          <img
            className="brand-mark"
            src="/citropy.svg"
            alt=""
            width={28}
            height={28}
            aria-hidden="true"
          />
          <span>Citropy</span>
          <ChannelBadge />
        </div>
        <div className="topbar-navigation">
          <NotificationCenter onOpen={onNotification} />
          <button
            className="icon-btn"
            type="button"
            onClick={onToggleSidebar}
            aria-expanded={sidebarOpen}
            title={t("Toggle sidebar")}
          >
            <PanelLeft size={15} />
          </button>
        </div>
      </div>
      <nav
        className="topbar-center breadcrumb"
        aria-label={t("Current workspace and view")}
      >
        <div className="workspace-breadcrumb">
          {isRemote() && <span className="environment-breadcrumb" title={environmentName()}><Server size={13} /><span className="truncate">{environmentName()}</span></span>}
          <WorkspaceSelector disabled={workspaceDisabled} />
          {(git?.branch || thread?.workspaceBranch) && view === "chat" && (
            <span className="branch" title={git?.branch || thread?.workspaceBranch}>
              <GitBranch size={12} />
              <span className="truncate">{git?.branch || thread?.workspaceBranch}</span>
            </span>
          )}
        </div>
        {(thread || view !== "chat") && (
          <>
            <span className="breadcrumb-separator" aria-hidden="true">/</span>
            <span className="thread-title truncate">
              {view === "git" ? t("Source control") : view === "github" ? "GitHub" : view === "usage" ? t("Usage") : view === "settings" ? t("Settings") : thread?.title}
            </span>
          </>
        )}
      </nav>

      <div className="topbar-right">
        <ComputerIndicator />
        <RunningShells onOpen={onNotification} />
        {project && (project.isGit && gitThread ? <GitActions key={gitThread.id} thread={gitThread} /> : <button type="button" className="icon-btn git-panel-trigger" aria-label={t("Git actions")} title={t("Git actions")} onClick={() => useApp.setState({ activeView: "git", readingThreadId: null })}><GitCommitHorizontal size={16} /><span className="git-trigger-label">Git</span></button>)}
        {view === "chat" && (
          <button
            className="icon-btn"
            type="button"
            onClick={toggleInspector}
            data-active={inspectorOpen}
            title={t("Toggle inspector")}
          >
            <PanelRight size={15} />
          </button>
        )}
      </div>
      {window.citropyDesktop && <WindowControls />}
    </header>
  );
}
