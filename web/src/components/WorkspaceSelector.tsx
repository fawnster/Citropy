import { useI18n } from "../lib/i18n.ts";
import { ChevronDown, FolderOpen, FolderPlus, LogOut } from "lucide-react";
import { chooseWorkspace, closeProject } from "../lib/actions.ts";
import { shortPath } from "../lib/format.ts";
import { selectProject, useApp } from "../lib/store.ts";
import { Menu } from "./Menu.tsx";

export function WorkspaceSelector({ disabled = false, onSelect }: { disabled?: boolean; onSelect?: () => void }) {
  const t = useI18n();
  const projects = useApp((state) => state.projects);
  const activeProjectId = useApp((state) => state.activeProjectId);
  const home = useApp((state) => state.home);
  const choosing = useApp((state) => state.choosingWorkspace);
  const project = projects.find((entry) => entry.id === activeProjectId);
  return (
    <Menu
      align="start"
      header={t("Workspaces")}
      className="workspace-menu"
      width={320}
      searchable
      searchPlaceholder={t("Find a workspace")}
      items={[
        ...projects.map((entry) => ({
          id: entry.id,
          label: entry.name,
          hint: shortPath(entry.path, home),
          selected: entry.id === activeProjectId,
          icon: <FolderOpen size={17} className="workspace-folder-icon" />,
          onSelect: () => {
            if (entry.id !== activeProjectId) selectProject(entry.id);
            onSelect?.();
          },
        })),
        { id: "open", label: t("Open another folder…"), hint: t("Add a folder as a workspace"), section: t("Workspace actions"), icon: <FolderPlus size={17} className="workspace-folder-icon" />, onSelect: chooseWorkspace },
        ...(project ? [{ id: "close", label: t("Close workspace"), hint: t("Remove {name} from the sidebar. Files stay on disk.", { name: project.name }), section: t("Workspace actions"), icon: <LogOut size={17} />, danger: true, onSelect: () => closeProject(project.id) }] : []),
      ]}
      trigger={({ toggle, id, open }) => (
        <button
          id={id}
          type="button"
          className="workspace-select"
          aria-label={t("Choose workspace, {name}", { name: project?.name ?? t("none selected") })}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={toggle}
          disabled={disabled || choosing}
          title={project?.path}
        >
          <FolderOpen size={18} />
          <span className="truncate">{choosing ? t("Choosing folder…") : project?.name ?? t("Open a workspace")}</span>
          <ChevronDown size={14} />
        </button>
      )}
    />
  );
}
