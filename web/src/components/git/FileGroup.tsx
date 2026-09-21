import { Minus, Plus } from "lucide-react";
import { FileIcon } from "../FileIcon.tsx";
import { fileLabel } from "./files.ts";
import { groupGitFiles } from "../../lib/git-files.ts";
import type { GitSelection } from "../GitReview.tsx";
import type { useI18n } from "../../lib/i18n.ts";
import type { GitFile, GitOperation } from "../../../../shared/protocol.ts";

export function FileGroup({
  title,
  list,
  inIndex,
  disabled,
  selection,
  t,
  match,
  act,
  setSelection,
}: {
  title: string;
  list: GitFile[];
  inIndex: boolean;
  disabled: boolean;
  selection: GitSelection | null;
  t: ReturnType<typeof useI18n>;
  match: (text: string) => boolean;
  act: (operation: GitOperation, value?: string, page?: number, remote?: string) => Promise<boolean>;
  setSelection: (value: GitSelection | null) => void;
}) {
  return (
    <section className="git-file-group">
      <header>
        <h3>
          {t(title)}
          <span className="git-count">{list.length}</span>
        </h3>
        <button
          className="btn git-stage-all"
          disabled={disabled || !list.length}
          onClick={() => void act(inIndex ? "unstageAll" : "stageAll")}
        >
          {inIndex ? <Minus size={14} /> : <Plus size={14} />}
          {inIndex ? t("Unstage all") : t("Stage all")}
        </button>
      </header>
      {!list.length && (
        <p className="git-list-hint">
          {inIndex
            ? t("Stage files to include them in your commit.")
            : t("No unstaged changes.")}
        </p>
      )}
      {groupGitFiles(list.filter((file) => match(file.path)), inIndex).map((group) => (
        <div className="git-change-category" key={group.kind}>
          <h4 className="change-category" data-kind={group.kind}>{t(group.label)}<span>{group.files.length}</span></h4>
          {group.files.map((file) => {
            const label = fileLabel(file, inIndex, t);
            const active =
              selection?.kind === "file" &&
              selection.path === file.path &&
              selection.staged === inIndex;
            const name = file.path.split("/").pop() ?? file.path;
            const directory = file.path.slice(0, -name.length);
            return (
              <div
                className="git-file-row"
                key={file.path}
                data-selected={active}
              >
                <button
                  className="git-file-name"
                  aria-pressed={active}
                  title={file.path + " · " + label}
                  onClick={() =>
                    setSelection({
                      kind: "file",
                      path: file.path,
                      staged: inIndex,
                    })
                  }
                >
                  <FileIcon path={file.path} />
                  <span className="git-file-label">
                    <strong className="truncate">{name}</strong>
                    {directory && <small className="truncate">{directory}</small>}
                  </span>
                  <span className="git-file-status" data-status={label}>
                    {label}
                  </span>
                </button>
                <button
                  className="icon-btn git-stage-button"
                  title={(inIndex ? t("Unstage ") : t("Stage ")) + file.path}
                  disabled={disabled}
                  onClick={() =>
                    void act(inIndex ? "unstage" : "stage", file.path)
                  }
                >
                  {inIndex ? <Minus size={15} /> : <Plus size={15} />}
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </section>
  );
}
