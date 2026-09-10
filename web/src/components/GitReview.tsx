import { useEffect, useState } from "react";
import { ChevronRight, FileCode2, LoaderCircle, RotateCcw } from "lucide-react";
import { fetchDiff, manageGit } from "../lib/actions.ts";
import { DiffView } from "./DiffView.tsx";
import type { FilePatch } from "../../../shared/protocol.ts";

export type GitSelection =
  | { kind: "file"; path: string; staged: boolean }
  | { kind: "commit"; hash: string }
  | { kind: "stash"; ref: string };

export function GitReview({
  projectId,
  selection,
  revision,
}: {
  projectId: string;
  selection: GitSelection;
  revision: number;
}) {
  const [patches, setPatches] = useState<FilePatch[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setPatches([]);
    setMessage("");
    const load = async () => {
      try {
        if (selection.kind === "file") {
          const patch = await fetchDiff(
            projectId,
            selection.path,
            selection.staged,
          );
          if (!cancelled) setPatches(patch ? [patch] : []);
        } else {
          const result = await manageGit(
            projectId,
            selection.kind === "commit" ? "show" : "showStash",
            selection.kind === "commit" ? selection.hash : selection.ref,
          );
          if (!cancelled && typeof result !== "string" && "kind" in result) {
            setPatches(result.patches);
            setMessage(result.message);
          }
        }
      } catch (error) {
        if (!cancelled) setError((error as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId, selection, revision, retry]);

  if (loading)
    return (
      <div className="git-preview-placeholder" role="status">
        <LoaderCircle size={22} className="git-spinner" />
        <span>Loading changes…</span>
      </div>
    );
  if (error)
    return (
      <div className="git-preview-placeholder" role="alert">
        <FileCode2 size={28} />
        <h3>Couldn’t load this preview</h3>
        <p>{error}</p>
        <button className="btn" onClick={() => setRetry((value) => value + 1)}>
          <RotateCcw size={14} />
          Try again
        </button>
      </div>
    );

  return (
    <div className="git-patches">
      {selection.kind === "commit" && message.includes("\n") && (
        <p className="git-commit-body">
          {message.slice(message.indexOf("\n")).trim()}
        </p>
      )}
      {patches.length === 0 && (
        <div className="git-preview-placeholder">
          <FileCode2 size={28} />
          <h3>No text changes to display</h3>
          <p>
            This can happen with an empty file, a binary file, or a
            metadata-only change.
          </p>
        </div>
      )}
      {patches.map((patch, index) =>
        selection.kind === "file" ? (
          patch.hunks.length ? (
            <DiffView
              key={index}
              patch={patch}
              showHeader={false}
              limit={200}
            />
          ) : (
            <div key={index} className="git-preview-placeholder">
              <FileCode2 size={28} />
              <h3>No text changes to display</h3>
              <p>The file is empty, binary, or only its metadata changed.</p>
            </div>
          )
        ) : (
          <details className="git-patch" key={index} open>
            <summary>
              <ChevronRight size={13} className="git-patch-chevron" />
              <FileCode2 size={15} />
              <span>{patch.path}</span>
              <span className="diff-stat">
                <span className="diff-plus">+{patch.added}</span>
                <span className="diff-minus">-{patch.removed}</span>
              </span>
            </summary>
            {patch.hunks.length ? (
              <DiffView patch={patch} showHeader={false} limit={160} />
            ) : (
              <p className="git-no-lines">No text changes in this file.</p>
            )}
          </details>
        ),
      )}
    </div>
  );
}
