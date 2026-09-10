import { useEffect, useState } from "react";
import { Collapsible } from "./Collapsible.tsx";
import { ChevronRight, GitCommitVertical, RotateCcw } from "./icons.ts";
import { DiffView } from "./DiffView.tsx";
import { commitAll, discardFile, fetchDiff, refreshGit } from "../lib/actions.ts";
import { useApp } from "../lib/store.ts";
import type { FilePatch, GitFile } from "../../../shared/protocol.ts";

function statusLabel(file: GitFile): string {
  if (file.untracked) return "new";
  const code = file.index !== " " ? file.index : file.work;
  if (code === "M") return "modified";
  if (code === "A") return "added";
  if (code === "D") return "deleted";
  if (code === "R") return "renamed";
  return "changed";
}

function Row({ file, projectId }: { file: GitFile; projectId: string }) {
  const [open, setOpen] = useState(false);
  const [patch, setPatch] = useState<FilePatch | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPatch(null);
    setError("");
    setLoading(true);
    void fetchDiff(projectId, file.path, file.staged).then((result) => {
      if (!cancelled) setPatch(result);
    }).catch((error: Error) => {
      if (!cancelled) setError(error.message);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [open, projectId, file.path, file.staged, file.added, file.removed]);

  const name = file.path.split("/").pop() ?? file.path;
  const dir = file.path.slice(0, file.path.length - name.length).replace(/\/$/, "");

  return (
    <div className="change" data-open={open}>
      <button className="change-head" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ChevronRight size={12} className="change-chevron" />
        <span className="change-name truncate">{name}</span>
        {dir && <span className="change-dir truncate">{dir}</span>}
        <span className="change-stat">
          {file.added > 0 && <span className="diff-plus">+{file.added}</span>}
          {file.removed > 0 && <span className="diff-minus">-{file.removed}</span>}
        </span>
        <span className="change-badge" data-kind={statusLabel(file)}>
          {statusLabel(file)}
        </span>
        <span
          className="change-action"
          role="button"
          tabIndex={-1}
          title="Discard changes"
          onClick={(event) => {
            event.stopPropagation();
            discardFile(projectId, file.path);
          }}
        >
          <RotateCcw size={12} />
        </span>
      </button>

      <Collapsible open={open} className="change-body">
        {patch ? (
          <DiffView patch={patch} showHeader={false} limit={40} />
        ) : (
          <div className="change-loading">{loading ? "Reading diff…" : error || "No textual diff"}</div>
        )}
      </Collapsible>
    </div>
  );
}

export function Changes() {
  const projectId = useApp((state) => state.activeProjectId);
  const git = useApp((state) => (projectId ? state.git[projectId] : undefined));
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (projectId) refreshGit(projectId);
  }, [projectId]);

  if (!projectId) return <div className="pane-empty">Open a workspace first.</div>;
  if (!git) return <div className="pane-empty">Not a git repository.</div>;

  return (
    <div className="changes">
      <div className="changes-list scroll">
        {git.files.length === 0 && <div className="pane-empty">Working tree is clean.</div>}
        {git.files.map((file) => (
          <Row key={file.path} file={file} projectId={projectId} />
        ))}
      </div>

      {git.files.length > 0 && (
        <form
          className="commit"
          onSubmit={(event) => {
            event.preventDefault();
            if (!message.trim()) return;
            commitAll(projectId, message.trim());
            setMessage("");
          }}
        >
          <input
            className="commit-input"
            value={message}
            placeholder={`Commit ${git.files.length} file${git.files.length === 1 ? "" : "s"} on ${git.branch}`}
            onChange={(event) => setMessage(event.target.value)}
          />
          <button className="btn" type="submit" data-variant="primary" disabled={!message.trim()}>
            <GitCommitVertical size={13} />
            Commit
          </button>
        </form>
      )}
    </div>
  );
}
