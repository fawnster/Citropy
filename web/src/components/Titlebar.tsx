import { Folder, GitBranch, PanelLeft, PanelRight } from "./icons.ts";
import { toggleInspector, useApp } from "../lib/store.ts";
import { NotificationCenter } from "./NotificationCenter.tsx";
import { ComputerIndicator } from "./ComputerPane.tsx";
import { WindowControls } from "./WindowControls.tsx";
import type { NotificationTarget } from "../../../shared/protocol.ts";

export function Titlebar({
  view,
  sidebarOpen,
  onToggleSidebar,
  onNotification,
}: {
  view: "chat" | "git" | "github" | "settings" | "usage";
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onNotification: (target: NotificationTarget) => void;
}) {
  const projects = useApp((state) => state.projects);
  const activeProjectId = useApp((state) => state.activeProjectId);
  const activeThreadId = useApp((state) => state.activeThreadId);
  const thread = useApp((state) =>
    activeThreadId ? state.threads[activeThreadId] : undefined,
  );
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
          Citropy
        </div>
        <button
          className="icon-btn"
          type="button"
          onClick={onToggleSidebar}
          aria-expanded={sidebarOpen}
          title="Toggle sidebar"
        >
          <PanelLeft size={15} />
        </button>
      </div>
      <nav
        className="topbar-center breadcrumb"
        aria-label="Current workspace and view"
      >
        {view === "settings" || view === "github" || view === "usage" ? (
          <span className="thread-title">
            {view === "github"
              ? "GitHub"
              : view === "usage"
                ? "Usage"
                : "Settings"}
          </span>
        ) : (
          <>
            <span
              className="workspace-breadcrumb"
              title={thread?.workspacePath ?? project?.path}
            >
              <Folder size={14} />
              <span className="truncate">
                {project?.name ?? "No workspace"}
              </span>
              {(git?.branch || thread?.workspaceBranch) && view === "chat" && (
                <span className="branch">
                  <GitBranch size={12} />
                  {git?.branch || thread?.workspaceBranch}
                </span>
              )}
            </span>
            {(thread || view === "git") && (
              <>
                <span className="breadcrumb-separator">/</span>
                <span className="thread-title truncate">
                  {view === "git" ? "Source control" : thread?.title}
                </span>
              </>
            )}
          </>
        )}
      </nav>

      <div className="topbar-right">
        <ComputerIndicator />
        <NotificationCenter onOpen={onNotification} />
        {view === "chat" && (
          <button
            className="icon-btn"
            type="button"
            onClick={toggleInspector}
            data-active={inspectorOpen}
            title="Toggle inspector"
          >
            <PanelRight size={15} />
          </button>
        )}
      </div>
      {window.citropyDesktop && <WindowControls />}
    </header>
  );
}
