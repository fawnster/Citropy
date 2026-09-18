import { useI18n } from "../lib/i18n.ts";
import { useEffect, useState, type CSSProperties } from "react";
import { ChevronRight, Folder, FolderOpen } from "./icons.ts";
import { FileIcon } from "./FileIcon.tsx";
import { fetchTree } from "../lib/actions.ts";
import { FilePreview } from "./FilePreview.tsx";
import { useApp } from "../lib/store.ts";
import type { FileEntry } from "../../../shared/protocol.ts";

interface NodeProps {
  entry: FileEntry;
  depth: number;
  projectId: string;
  onOpen: (path: string) => void;
}

function Node({ entry, depth, projectId, onOpen }: NodeProps) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState("");
  const connected = useApp((state) => state.connected);

  useEffect(() => {
    if (!open || children || !connected) return;
    let cancelled = false;
    setError("");
    void fetchTree(projectId, entry.path)
      .then((entries) => {
        if (!cancelled) setChildren(entries);
      })
      .catch((error: Error) => {
        if (!cancelled) setError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [open, children, projectId, entry.path, connected]);

  if (!entry.dir) {
    return (
      <button
        type="button"
        className="tree-row"
        style={{ "--depth": depth } as CSSProperties}
        onClick={() => onOpen(entry.path)}
      >
        <span className="tree-spacer" />
        <FileIcon path={entry.path} />
        <span className="truncate">{entry.name}</span>
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        className="tree-row"
        style={{ "--depth": depth } as CSSProperties}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight size={11} className="tree-chevron" data-open={open} />
        {open ? (
          <FolderOpen size={12} className="tree-icon" />
        ) : (
          <Folder size={12} className="tree-icon" />
        )}
        <span className="truncate">{entry.name}</span>
      </button>
      {open && error && (
        <div className="pane-empty" role="alert">
          {error}
        </div>
      )}
      {open &&
        (children ?? []).map((child) => (
          <Node
            key={child.path}
            entry={child}
            depth={depth + 1}
            projectId={projectId}
            onOpen={onOpen}
          />
        ))}
    </>
  );
}

export function FileTree() {
  const t = useI18n();
  const threadId = useApp((state) => state.activeThreadId);
  const projectId = useApp((state) => state.activeProjectId);
  const connected = useApp((state) => state.connected);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!projectId || !connected) return;
    let cancelled = false;
    setEntries([]);
    setError("");
    void fetchTree(projectId)
      .then((entries) => {
        if (!cancelled) setEntries(entries);
      })
      .catch((error: Error) => {
        if (!cancelled) setError(error.message);
      });
    setPreview(null);
    return () => {
      cancelled = true;
    };
  }, [projectId, threadId, connected]);

  if (!projectId)
    return <div className="pane-empty">{t("Open a workspace first.")}</div>;

  if (preview) {
    return (
      <FilePreview
        projectId={projectId}
        path={preview}
        onClose={() => setPreview(null)}
      />
    );
  }

  return (
    <div className="tree scroll">
      {entries.map((entry) => (
        <Node
          key={`${projectId}:${threadId}:${entry.path}`}
          entry={entry}
          depth={0}
          projectId={projectId}
          onOpen={setPreview}
        />
      ))}
      {entries.length === 0 && (
        <div className="pane-empty" role={error ? "alert" : undefined}>
          {error || t("Nothing to show.")}
        </div>
      )}
    </div>
  );
}
