import { useState } from "react";
import { AnimatePresence } from "motion/react";
import { ChevronDown, FolderOpen, FolderPlus, GitFork, LoaderCircle, LogOut, Monitor, Server } from "lucide-react";
import { NewSshConnection } from "./EnvironmentSettings.tsx";
import { selectEnvironment, useEnvironments, useWorkspaceCatalog, environmentName, isRemote } from "../lib/environment.ts";
import { reportError } from "../lib/api.ts";
import { useI18n } from "../lib/i18n.ts";
import { chooseWorkspaceOn, closeProject, createThread } from "../lib/actions.ts";
import { shortPath } from "../lib/format.ts";
import { selectProject, useApp } from "../lib/store.ts";
import { Menu, type MenuItem } from "./Menu.tsx";

export function WorkspaceSelector({ disabled = false, onSelect }: { disabled?: boolean; onSelect?: () => void }) {
  const t = useI18n();
  const environments = useEnvironments();
  const catalog = useWorkspaceCatalog();
  const [adding, setAdding] = useState(false);
  const projects = useApp(state => state.projects);
  const activeProjectId = useApp(state => state.activeProjectId);
  const home = useApp(state => state.home);
  const choosing = useApp(state => state.choosingWorkspace);
  const project = projects.find(entry => entry.id === activeProjectId);
  const desktop = Boolean(window.citropyDesktop?.connectEnvironment);
  const group = (id: string): MenuItem[] => {
    const current = id === environments.activeId;
    const entries = current ? projects : catalog[id]?.projects ?? [];
    const root = current ? home : catalog[id]?.home ?? "";
    return [
      ...entries.map(entry => ({
        id: `${id}:${entry.id}`, label: entry.name, hint: shortPath(entry.path, root),
        selected: current && entry.id === activeProjectId,
        icon: <FolderOpen size={17} className="workspace-folder-icon" />,
        onSelect: () => {
          if (current) { if (entry.id !== activeProjectId) selectProject(entry.id); onSelect?.(); }
          else void selectEnvironment(id, entry.id).then(() => onSelect?.()).catch(reportError);
        },
      })),
      ...(!current && !catalog[id] ? [{ id: `${id}:load`, label: t("Load workspaces"), icon: <Server size={17} />, onSelect: () => { void selectEnvironment(id).catch(reportError); } }] : []),
      { id: `${id}:open`, label: t("Open another folder…"), icon: <FolderPlus size={17} className="workspace-folder-icon" />, disabled: choosing, onSelect: () => { void chooseWorkspaceOn(id); } },
    ];
  };
  const items: MenuItem[] = desktop ? [
    { id: "environment:local", label: t("Local"), icon: <Monitor size={17} />, children: group("local") },
    ...environments.connections.map(entry => ({
      id: `environment:${entry.id}`, label: entry.name, hint: entry.target,
      icon: entry.status === "connecting" ? <LoaderCircle size={17} className="spin" /> : <Server size={17} />,
      children: group(entry.id),
    })),
    { id: "environment:add", label: t("Connect over SSH…"), section: t("Workspace actions"), icon: <Server size={17} />, onSelect: () => setAdding(true) },
  ] : group("local");
  if (project?.isGit) items.push({ id: "new-worktree", label: t("New thread with workspace options…"), section: t("Workspace actions"), icon: <GitFork size={17} />, onSelect: () => { void createThread(undefined, true); } });
  if (project) items.push({ id: "close", label: t("Close workspace"), hint: t("Remove {name} from the sidebar. Files stay on disk.", { name: project.name }), section: t("Workspace actions"), icon: <LogOut size={17} />, danger: true, onSelect: () => closeProject(project.id) });
  return <>
    <Menu align="start" header={t("Workspaces")} className="workspace-menu" width={340} searchable searchPlaceholder={t("Find a workspace")} items={items}
      trigger={({ toggle, id, open }) => <button id={id} type="button" className="workspace-select"
        aria-label={t("Choose workspace, {name}", { name: project?.name ?? t("none selected") })}
        aria-haspopup="menu" aria-expanded={open} onClick={toggle} disabled={disabled || choosing}
        title={isRemote() ? `${environmentName()}: ${project?.path ?? ""}` : project?.path}>
        {isRemote() ? <Server size={18} /> : <FolderOpen size={18} />}
        <span className="truncate">{choosing ? t("Choosing folder…") : project?.name ?? t("Open a workspace")}</span>
        <ChevronDown size={14} />
      </button>}
    />
    <AnimatePresence>{adding && <NewSshConnection onClose={() => setAdding(false)} />}</AnimatePresence>
  </>;
}
