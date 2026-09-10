import { ResizeHandle } from "./ResizeHandle.tsx";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  FileCode2,
  FilePlus2,
  Files,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  Globe2,
  History,
  LoaderCircle,
  Minus,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { chooseWorkspace, manageGit } from "../lib/actions.ts";
import { useApp, viewportWidth } from "../lib/store.ts";
import { shortPath } from "../lib/format.ts";
import { Menu } from "./Menu.tsx";
import { SectionSidebar } from "./SectionSidebar.tsx";
import { GitDialog, type GitDialogAction } from "./GitDialog.tsx";
import { GitReview, type GitSelection } from "./GitReview.tsx";
import type {
  GitFile,
  GitOperation,
  GitOverview,
} from "../../../shared/protocol.ts";

type Section = "Changes" | "History" | "Branches" | "Stashes" | "Remotes";
type Feedback = { error: boolean; text: string; detail?: string };

const tabs: Array<{ name: Section; icon: LucideIcon }> = [
  { name: "Changes", icon: Files },
  { name: "History", icon: History },
  { name: "Branches", icon: GitBranch },
  { name: "Stashes", icon: Archive },
  { name: "Remotes", icon: Globe2 },
];

const workingLabels: Partial<Record<GitOperation, string>> = {
  overview: "Refreshing repository",
  history: "Loading history",
  init: "Initializing repository",
  stage: "Staging file",
  unstage: "Unstaging file",
  stageAll: "Staging changes",
  unstageAll: "Unstaging changes",
  commit: "Creating commit",
  createBranch: "Creating branch",
  switchBranch: "Switching branch",
  deleteBranch: "Deleting branch",
  merge: "Merging branch",
  abortMerge: "Aborting merge",
  fetch: "Fetching remote updates",
  pull: "Pulling changes",
  push: "Pushing commits",
  stash: "Saving changes",
  applyStash: "Applying stash",
  dropStash: "Deleting stash",
  addRemote: "Connecting remote",
  removeRemote: "Removing remote",
  publish: "Publishing branch",
  discardWorktree: "Discarding changes",
};

const doneLabels: Partial<Record<GitOperation, string>> = {
  init: "Repository initialized. Review your files to make the first commit.",
  stage: "File staged for commit.",
  unstage: "File moved back to unstaged changes.",
  stageAll: "All changes staged.",
  unstageAll: "All changes unstaged.",
  commit: "Commit created.",
  createBranch: "Branch created and checked out.",
  switchBranch: "Branch switched.",
  deleteBranch: "Local branch deleted.",
  merge: "Merge completed.",
  abortMerge: "Merge aborted.",
  fetch: "Remote information updated.",
  pull: "Branch updated from its upstream.",
  push: "Push completed.",
  stash: "Changes saved to a stash.",
  applyStash: "Stash applied. The saved copy is still available.",
  dropStash: "Stash deleted.",
  addRemote: "Remote connected.",
  removeRemote: "Remote configuration removed.",
  publish: "Branch published and upstream configured.",
  discardWorktree: "Unstaged changes discarded.",
};

function isConflict(file: GitFile) {
  return (
    file.index === "U" ||
    file.work === "U" ||
    ["AA", "DD"].includes(file.index + file.work)
  );
}

function fileLabel(file: GitFile, staged: boolean) {
  if (isConflict(file)) return "Conflict";
  if (file.untracked) return "New";
  return (
    (
      {
        M: "Modified",
        A: "Added",
        D: "Deleted",
        R: "Renamed",
        C: "Copied",
        T: "Type changed",
      } as Record<string, string>
    )[staged ? file.index : file.work] ?? "Changed"
  );
}

function readableError(error: string) {
  if (/unable to auto-detect email|please tell me who you are/i.test(error))
    return "Set your Git name and email before making a commit.";
  if (/conflict|automatic merge failed/i.test(error))
    return "Some changes conflict. Review the affected files before continuing.";
  if (/would be overwritten/i.test(error))
    return "Commit or stash your local changes before switching.";
  if (/not fully merged/i.test(error))
    return "This branch has unmerged commits. Merge them before deleting the branch.";
  if (/authentication|permission denied|could not read username/i.test(error))
    return "Git couldn’t authenticate with this remote. Check your Git credentials.";
  return (
    error
      .split("\n")
      .find((line) => line.trim() && !line.startsWith("Command failed:"))
      ?.replace(/^(fatal|error):\s*/i, "") ??
    "Git couldn’t complete the action."
  );
}

function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="git-empty">
      <Icon size={34} strokeWidth={1.3} />
      <h2>{title}</h2>
      <div className="git-empty-copy">{children}</div>
      {action && <div className="git-empty-action">{action}</div>}
    </div>
  );
}

export function GitManager({
  sidebarOpen,
  onCloseSidebar,
  onBack,
}: {
  sidebarOpen: boolean;
  onCloseSidebar: () => void;
  onBack: () => void;
}) {
  const projectId = useApp((state) => state.activeProjectId);
  const thread = useApp((state) => state.threads[state.activeThreadId ?? ""]);
  const sourceProject = useApp((state) =>
    state.projects.find((entry) => entry.id === projectId),
  );
  const project =
    sourceProject && thread?.projectId === projectId && thread.workspacePath
      ? { ...sourceProject, path: thread.workspacePath }
      : sourceProject;
  const home = useApp((state) => state.home);
  const connected = useApp((state) => state.connected);
  const [data, setData] = useState<GitOverview | null>(null);
  const [section, setSection] = useState<Section>("Changes");
  const [busy, setBusy] = useState<GitOperation | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState("");
  const [selection, setSelection] = useState<GitSelection | null>(null);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [dialog, setDialog] = useState<GitDialogAction | null>(null);
  const generation = useRef(0);
  const pending = useRef(false);
  const dialogTrigger = useRef<HTMLElement | null>(null);

  const firstFile = (overview: GitOverview): GitSelection | null => {
    const file =
      overview.status?.files.find(
        (entry) => entry.untracked || entry.work !== " ",
      ) ?? overview.status?.files[0];
    return file
      ? {
          kind: "file",
          path: file.path,
          staged: file.staged && !file.untracked && file.work === " ",
        }
      : null;
  };

  const receive = (overview: GitOverview, page: number) => {
    setData(overview);
    setOffset(page);
    setRevision((value) => value + 1);
    setSelection((previous) => {
      if (previous?.kind === "file") {
        const file = overview.status?.files.find(
          (entry) => entry.path === previous.path,
        );
        if (file)
          return {
            ...previous,
            staged: previous.staged
              ? file.staged
              : !file.untracked && file.work === " ",
          };
        return firstFile(overview);
      }
      if (
        previous?.kind === "commit" &&
        !overview.commits.some((entry) => entry.hash === previous.hash)
      )
        return overview.commits[0]
          ? { kind: "commit", hash: overview.commits[0].hash }
          : null;
      if (
        previous?.kind === "stash" &&
        !overview.stashes.some((entry) => entry.ref === previous.ref)
      )
        return null;
      return previous;
    });
  };

  useEffect(() => {
    const epoch = ++generation.current;
    if (!projectId || !connected) {
      setBusy(null);
      return;
    }
    setBusy("overview");
    pending.current = true;
    void manageGit(projectId, "overview")
      .then((result) => {
        if (
          epoch !== generation.current ||
          typeof result === "string" ||
          !("repository" in result)
        )
          return;
        setData(result);
        setSelection(
          section === "Changes"
            ? firstFile(result)
            : section === "History" && result.commits[0]
              ? { kind: "commit", hash: result.commits[0].hash }
              : null,
        );
        setRevision((value) => value + 1);
      })
      .catch((error: Error) => {
        if (epoch === generation.current)
          setFeedback({
            error: true,
            text: readableError(error.message),
            detail: error.message,
          });
      })
      .finally(() => {
        if (epoch === generation.current) {
          pending.current = false;
          setBusy(null);
        }
      });
    return () => {
      generation.current++;
      pending.current = false;
    };
  }, [projectId, connected]);

  const act = async (
    operation: GitOperation,
    value?: string,
    page = 0,
    remote?: string,
  ) => {
    if (!projectId || pending.current || !connected) return false;
    const epoch = generation.current;
    pending.current = true;
    setBusy(operation);
    setFeedback(null);
    try {
      const result = await manageGit(projectId, operation, value, page, remote);
      if (epoch !== generation.current) return false;
      if (typeof result !== "string" && "repository" in result)
        receive(result, page);
      else {
        if (operation === "commit") setMessage("");
        try {
          const updated = await manageGit(projectId, "overview");
          if (epoch !== generation.current) return false;
          if (typeof updated !== "string" && "repository" in updated)
            receive(updated, 0);
        } catch (error) {
          if (epoch !== generation.current) return false;
          setFeedback({
            error: true,
            text:
              (doneLabels[operation] ?? "Action completed.") +
              " Refresh to load the latest repository state.",
            detail: (error as Error).message,
          });
          return true;
        }
        setFeedback({
          error: false,
          text: doneLabels[operation] ?? "Repository updated.",
        });
      }
      return true;
    } catch (error) {
      if (epoch === generation.current) {
        const detail = (error as Error).message;
        setFeedback({ error: true, text: readableError(detail), detail });
        try {
          const updated = await manageGit(projectId, "overview");
          if (
            epoch === generation.current &&
            typeof updated !== "string" &&
            "repository" in updated
          ) {
            receive(updated, 0);
            if (
              ["merge", "pull", "applyStash"].includes(operation) &&
              updated.status?.files.some(isConflict)
            ) {
              setSection("Changes");
              setFilter("");
              setSelection(firstFile(updated));
              setFeedback(null);
              return true;
            }
          }
        } catch {}
      }
      return false;
    } finally {
      if (epoch === generation.current) {
        pending.current = false;
        setBusy(null);
      }
    }
  };

  const changeSection = (next: Section) => {
    if (viewportWidth() <= 720) onCloseSidebar();
    setSection(next);
    setFilter("");
    if (next === "Changes" && data) setSelection(firstFile(data));
    else if (next === "History" && data?.commits[0])
      setSelection({ kind: "commit", hash: data.commits[0].hash });
    else setSelection(null);
  };

  const showDialog = (action: GitDialogAction) => {
    dialogTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setFeedback(null);
    setDialog(action);
  };
  const files = data?.status?.files ?? [];
  const conflicts = files.filter(isConflict);
  const staged = files.filter((file) => file.staged && !isConflict(file));
  const unstaged = files.filter(
    (file) => file.untracked || file.work !== " " || isConflict(file),
  );
  const localBranches = data?.branches.filter((entry) => !entry.remote) ?? [];
  const remoteBranches = data?.branches.filter((entry) => entry.remote) ?? [];
  const currentBranch = localBranches.find((entry) => entry.current);
  const branch = data?.status?.branch ?? "";
  const upstream = currentBranch?.upstream;
  const disabled = Boolean(busy) || !connected;
  const canCommit =
    !disabled &&
    message.trim() &&
    !conflicts.length &&
    (staged.length || data?.mergeInProgress);
  const selectedFile =
    selection?.kind === "file"
      ? files.find((file) => file.path === selection.path)
      : undefined;
  const selectedCommit =
    selection?.kind === "commit"
      ? data?.commits.find((commit) => commit.hash === selection.hash)
      : undefined;
  const selectedStash =
    selection?.kind === "stash"
      ? data?.stashes.find((stash) => stash.ref === selection.ref)
      : undefined;
  const match = (text: string) =>
    text.toLowerCase().includes(filter.toLowerCase());
  const counts = {
    Changes: files.length,
    History: undefined,
    Branches: localBranches.length,
    Stashes: data?.stashes.length,
    Remotes: data?.remotes.length,
  };

  const createBranch = () =>
    showDialog({
      operation: "createBranch",
      title: "Create a branch",
      description:
        "Your new branch will start from " +
        branch +
        ". Citropy will switch to it after creation.",
      label: "Create and switch",
      fields: "branch",
    });
  const saveStash = () =>
    showDialog({
      operation: "stash",
      title: "Save changes for later",
      description:
        "Save staged, unstaged, and new files in a stash, then return to a clean working tree.",
      label: "Save stash",
      fields: "stash",
    });
  const addRemote = () =>
    showDialog({
      operation: "addRemote",
      title: "Connect a remote",
      description:
        "Link this workspace to an existing remote repository. You choose when to publish your commits.",
      label: "Add remote",
      fields: "remote",
    });
  const reviewChanges = (
    <button
      className="btn"
      data-variant="primary"
      onClick={() => changeSection("Changes")}
    >
      Review changes
      <ArrowRight size={15} />
    </button>
  );

  const fileList = (title: string, list: GitFile[], inIndex: boolean) => (
    <section className="git-file-group">
      <header>
        <h3>
          {title}
          <span className="git-count">{list.length}</span>
        </h3>
        <button
          className="git-text-button"
          disabled={disabled || !list.length}
          onClick={() => void act(inIndex ? "unstageAll" : "stageAll")}
        >
          {inIndex ? "Unstage all" : "Stage all"}
        </button>
      </header>
      {!list.length && (
        <p className="git-list-hint">
          {inIndex
            ? "Stage files to include them in your commit."
            : "No unstaged changes."}
        </p>
      )}
      {list
        .filter((file) => match(file.path))
        .map((file) => {
          const label = fileLabel(file, inIndex);
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
                {file.untracked ? (
                  <FilePlus2 size={16} />
                ) : (
                  <FileCode2 size={16} />
                )}
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
                title={(inIndex ? "Unstage " : "Stage ") + file.path}
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
    </section>
  );

  return (
    <section className="section-view" aria-label="Git manager">
      {sidebarOpen && (
        <SectionSidebar title="Source control" onBack={onBack}>
          {tabs.map(({ name, icon: Icon }) => (
            <button
              className="section-link"
              type="button"
              key={name}
              aria-current={section === name ? "page" : undefined}
              onClick={() => changeSection(name)}
            >
              <Icon size={17} />
              <span>{name}</span>
              {data?.repository && counts[name] !== undefined && (
                <span className="section-count">{counts[name]}</span>
              )}
            </button>
          ))}
        </SectionSidebar>
      )}
      <div className="git-manager">
        <header className="git-header">
          <div className="git-heading">
            <FolderGit2 size={24} strokeWidth={1.6} />
            <div>
              <h1>{section}</h1>
              <p title={project?.path}>
                {project
                  ? shortPath(project.path, home)
                  : "No workspace selected"}
              </p>
            </div>
          </div>
          <div className="git-repository-state">
            {data?.repository && (
              <div className="git-current-branch">
                <GitBranch size={16} />
                <strong>
                  {branch === "detached" ? "Detached HEAD" : branch}
                </strong>
                <span>
                  {!data.hasCommits
                    ? "No commits yet"
                    : upstream
                      ? data.status?.ahead || data.status?.behind
                        ? (data.status?.ahead ?? 0) +
                          " ahead · " +
                          (data.status?.behind ?? 0) +
                          " behind"
                        : "Up to date"
                      : "Local branch"}
                </span>
              </div>
            )}
            <button
              className="icon-btn"
              title="Refresh repository"
              disabled={disabled || !projectId}
              onClick={() => void act("overview", undefined, offset)}
            >
              <RefreshCw
                size={17}
                className={busy === "overview" ? "git-spinner" : undefined}
              />
            </button>
          </div>
        </header>

        {!connected && (
          <div className="git-alert" role="status">
            <CircleAlert size={17} />
            <p>
              Connection lost. Your repository will be available when Citropy
              reconnects.
            </p>
          </div>
        )}
        {feedback?.error && !dialog && (
          <div className="git-alert" role="alert">
            <CircleAlert size={17} />
            <div>
              <strong>{feedback.text}</strong>
              {feedback.detail && (
                <details>
                  <summary>Show Git details</summary>
                  <pre>{feedback.detail}</pre>
                </details>
              )}
            </div>
            <button
              className="icon-btn"
              aria-label="Dismiss error"
              onClick={() => setFeedback(null)}
            >
              <X size={15} />
            </button>
          </div>
        )}

        <div className="git-content">
          {!projectId ? (
            <EmptyState
              icon={FolderGit2}
              title="Choose a workspace"
              action={
                <button
                  className="btn"
                  data-variant="primary"
                  onClick={chooseWorkspace}
                >
                  Open workspace
                </button>
              }
            >
              <p>
                Open a project folder to review changes and manage its Git
                repository.
              </p>
            </EmptyState>
          ) : !data ? (
            busy ? (
              <div className="git-preview-placeholder" role="status">
                <LoaderCircle className="git-spinner" size={24} />
                <p>Reading repository…</p>
              </div>
            ) : (
              <EmptyState icon={CircleAlert} title="Repository unavailable">
                <p>Refresh to try loading this workspace again.</p>
                <button
                  className="btn"
                  disabled={disabled}
                  onClick={() => void act("overview")}
                >
                  Try again
                </button>
              </EmptyState>
            )
          ) : !data.repository ? (
            <EmptyState
              icon={FolderGit2}
              title="Start tracking this project"
              action={
                <button
                  className="btn"
                  data-variant="primary"
                  disabled={disabled}
                  onClick={() => void act("init")}
                >
                  <Plus size={16} />
                  Initialize repository
                </button>
              }
            >
              <p>
                Git keeps a history of your files so you can review changes,
                save commits, and work on branches.
              </p>
              <p className="git-empty-path">{project?.name}</p>
            </EmptyState>
          ) : (
            <>
              {section === "Changes" && (
                <div className="git-changes-layout">
                  {(data.mergeInProgress || conflicts.length > 0) && (
                    <div className="git-merge-banner">
                      <GitMerge size={19} />
                      <div>
                        <strong>
                          {conflicts.length
                            ? conflicts.length +
                              " file" +
                              (conflicts.length === 1 ? " needs" : "s need") +
                              " conflict resolution"
                            : "Ready to finish the merge"}
                        </strong>
                        <p>
                          {conflicts.length
                            ? "Resolve conflict markers in your files, then stage the resolved changes."
                            : "Create a commit to complete this merge."}
                        </p>
                      </div>
                      {data.mergeInProgress && (
                        <button
                          className="btn"
                          disabled={disabled}
                          onClick={() =>
                            showDialog({
                              operation: "abortMerge",
                              title: "Abort this merge?",
                              description:
                                "Return to the state before the merge began. Changes made during the merge may be lost.",
                              label: "Abort merge",
                              danger: true,
                            })
                          }
                        >
                          Abort merge
                        </button>
                      )}
                    </div>
                  )}
                  {!data.hasCommits && (
                    <div className="git-first-commit">
                      <GitCommitHorizontal size={18} />
                      <span>
                        <strong>Make your first commit.</strong> Review your
                        files, stage the ones to track, then write a commit
                        message.
                      </span>
                    </div>
                  )}
                  <div
                    className="git-split"
                    data-detail={selection?.kind === "file"}
                  >
                    <div className="git-change-list">
                      <label className="git-filter">
                        <Search size={15} />
                        <input
                          aria-label="Filter changed files"
                          placeholder="Filter files…"
                          value={filter}
                          onChange={(event) => setFilter(event.target.value)}
                        />
                        {filter && (
                          <button
                            className="icon-btn"
                            aria-label="Clear file filter"
                            onClick={() => setFilter("")}
                          >
                            <X size={13} />
                          </button>
                        )}
                      </label>
                      <div className="git-file-groups scroll">
                        {fileList("Unstaged changes", unstaged, false)}
                        {fileList("Staged for commit", staged, true)}
                        {filter && !files.some((file) => match(file.path)) && (
                          <p className="git-list-hint">
                            No files match “{filter}”.
                          </p>
                        )}
                      </div>
                      <form
                        className="git-commit-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (canCommit) void act("commit", message.trim());
                        }}
                      >
                        <label htmlFor="git-commit-message">
                          Commit message
                        </label>
                        <textarea
                          id="git-commit-message"
                          rows={3}
                          value={message}
                          disabled={busy === "commit"}
                          onChange={(event) => setMessage(event.target.value)}
                          placeholder={
                            data.hasCommits
                              ? "What changed, and why?"
                              : "Initial commit"
                          }
                        />
                        <div className="git-commit-target">
                          <GitBranch size={13} />
                          <span className="truncate">{branch}</span>
                          <span>{staged.length} staged</span>
                        </div>
                        <button
                          className="btn"
                          data-variant="primary"
                          disabled={!canCommit}
                        >
                          {busy === "commit" ? (
                            <LoaderCircle size={15} className="git-spinner" />
                          ) : (
                            <GitCommitHorizontal size={17} />
                          )}
                          {data.mergeInProgress
                            ? "Complete merge"
                            : data.hasCommits
                              ? "Commit staged changes"
                              : "Create first commit"}
                        </button>
                      </form>
                    </div>
                    <ResizeHandle panel="git" inline />
                    <section
                      className="git-review-pane"
                      aria-label="File preview"
                    >
                      {selection?.kind === "file" && selectedFile ? (
                        <>
                          <header className="git-review-header">
                            <button
                              className="icon-btn git-mobile-back"
                              aria-label="Back to changed files"
                              onClick={() => setSelection(null)}
                            >
                              <ArrowLeft size={17} />
                            </button>
                            <div>
                              <h2>{selection.path}</h2>
                              <p>
                                {selection.staged
                                  ? "Staged for commit"
                                  : fileLabel(selectedFile, false) +
                                    " · Unstaged changes"}
                              </p>
                            </div>
                            <div className="git-inline-actions">
                              {!selection.staged && (
                                <button
                                  className="icon-btn git-danger"
                                  title={"Discard changes in " + selection.path}
                                  disabled={disabled}
                                  onClick={() =>
                                    showDialog({
                                      operation: "discardWorktree",
                                      value: selection.path,
                                      title: selectedFile.untracked
                                        ? "Delete this new file?"
                                        : "Discard unstaged changes?",
                                      description: selectedFile.untracked
                                        ? selection.path +
                                          " will be permanently deleted."
                                        : "Unstaged edits to " +
                                          selection.path +
                                          " will be lost. Staged changes will be kept.",
                                      label: selectedFile.untracked
                                        ? "Delete file"
                                        : "Discard changes",
                                      danger: true,
                                    })
                                  }
                                >
                                  <Trash2 size={15} />
                                </button>
                              )}
                              <button
                                className="btn"
                                disabled={disabled}
                                onClick={() =>
                                  void act(
                                    selection.staged ? "unstage" : "stage",
                                    selection.path,
                                  )
                                }
                              >
                                {selection.staged ? (
                                  <Minus size={14} />
                                ) : (
                                  <Plus size={14} />
                                )}
                                {selection.staged ? "Unstage" : "Stage file"}
                              </button>
                            </div>
                          </header>
                          <div className="git-review-scroll scroll">
                            <GitReview
                              projectId={projectId}
                              selection={selection}
                              revision={revision}
                            />
                          </div>
                        </>
                      ) : (
                        <EmptyState
                          icon={
                            files.length
                              ? FileCode2
                              : data.hasCommits
                                ? CheckCheck
                                : FilePlus2
                          }
                          title={
                            files.length
                              ? "Select a file to review"
                              : data.hasCommits
                                ? "Working tree is clean"
                                : "Add files to get started"
                          }
                        >
                          <p>
                            {files.length
                              ? "Choose a file on the left to see exactly what will change."
                              : data.hasCommits
                                ? "Your files match the latest commit. New edits will appear here."
                                : "Create or copy files into this workspace. They’ll appear here, ready for your first commit."}
                          </p>
                        </EmptyState>
                      )}
                    </section>
                  </div>
                </div>
              )}

              {section === "History" &&
                (!data.hasCommits ? (
                  <EmptyState
                    icon={History}
                    title="Your history starts with a commit"
                    action={reviewChanges}
                  >
                    <p>
                      Commits are saved checkpoints of your work. Review your
                      changes to create the first one.
                    </p>
                  </EmptyState>
                ) : (
                  <div
                    className="git-split"
                    data-detail={selection?.kind === "commit"}
                  >
                    <div className="git-history-list">
                      <header className="git-list-heading">
                        <h2>Commit history</h2>
                        <p>
                          <GitBranch size={13} />
                          {branch}
                        </p>
                      </header>
                      <div className="scroll git-commits">
                        {data.commits.map((commit) => (
                          <button
                            className="git-history-row"
                            key={commit.hash}
                            aria-pressed={
                              selection?.kind === "commit" &&
                              selection.hash === commit.hash
                            }
                            onClick={() =>
                              setSelection({
                                kind: "commit",
                                hash: commit.hash,
                              })
                            }
                          >
                            <GitCommitHorizontal size={19} />
                            <span>
                              <strong>{commit.subject}</strong>
                              <small>
                                {commit.author} ·{" "}
                                {new Date(commit.date).toLocaleDateString(
                                  undefined,
                                  { month: "short", day: "numeric" },
                                )}
                              </small>
                              <code>{commit.hash.slice(0, 7)}</code>
                            </span>
                            {commit.refs.includes("HEAD") && (
                              <span className="git-tag">Latest</span>
                            )}
                          </button>
                        ))}
                        {!data.commits.length && (
                          <p className="git-list-hint">
                            No more commits on this page.
                          </p>
                        )}
                      </div>
                      <footer className="git-pagination">
                        <button
                          className="icon-btn"
                          aria-label="Previous commits page"
                          disabled={disabled || offset === 0}
                          onClick={() =>
                            void act(
                              "history",
                              undefined,
                              Math.max(0, offset - 50),
                            )
                          }
                        >
                          <ChevronLeft size={16} />
                        </button>
                        <span>
                          {data.commits.length
                            ? offset +
                              1 +
                              " - " +
                              (offset + data.commits.length)
                            : "End of history"}
                        </span>
                        <button
                          className="icon-btn"
                          aria-label="Next commits page"
                          disabled={disabled || data.commits.length < 50}
                          onClick={() =>
                            void act("history", undefined, offset + 50)
                          }
                        >
                          <ChevronRight size={16} />
                        </button>
                      </footer>
                    </div>
                    <ResizeHandle panel="git" inline />
                    <section
                      className="git-review-pane"
                      aria-label="Commit preview"
                    >
                      {selection?.kind === "commit" && selectedCommit ? (
                        <>
                          <header className="git-review-header">
                            <button
                              className="icon-btn git-mobile-back"
                              aria-label="Back to history"
                              onClick={() => setSelection(null)}
                            >
                              <ArrowLeft size={17} />
                            </button>
                            <div>
                              <h2>{selectedCommit.subject}</h2>
                              <p>
                                {selectedCommit.author} ·{" "}
                                {new Date(selectedCommit.date).toLocaleString()}{" "}
                                · <code>{selectedCommit.hash.slice(0, 8)}</code>
                              </p>
                              {selectedCommit.refs && (
                                <span className="git-commit-refs">
                                  {selectedCommit.refs}
                                </span>
                              )}
                            </div>
                          </header>
                          <div className="git-review-scroll scroll">
                            <GitReview
                              projectId={projectId}
                              selection={selection}
                              revision={revision}
                            />
                          </div>
                        </>
                      ) : (
                        <EmptyState
                          icon={GitCommitHorizontal}
                          title="Review a saved change"
                        >
                          <p>
                            Select a commit to see its message and file changes.
                          </p>
                        </EmptyState>
                      )}
                    </section>
                  </div>
                ))}

              {section === "Branches" && (
                <div className="git-page scroll">
                  <header className="git-section-heading">
                    <div>
                      <p>
                        Keep separate lines of work and bring changes together.
                      </p>
                    </div>
                    {data.hasCommits && (
                      <button
                        className="btn"
                        data-variant="primary"
                        disabled={disabled}
                        onClick={createBranch}
                      >
                        <Plus size={15} />
                        New branch
                      </button>
                    )}
                  </header>
                  {!data.hasCommits && (
                    <div className="git-current-summary">
                      <GitBranch size={22} />
                      <div>
                        <small>Current branch</small>
                        <strong>{branch}</strong>
                      </div>
                      <span className="git-tag">Awaiting first commit</span>
                    </div>
                  )}
                  {!data.hasCommits ? (
                    <EmptyState
                      icon={GitBranch}
                      title="Create a commit before branching"
                      action={reviewChanges}
                    >
                      <p>
                        Your repository is initialized, but{" "}
                        <strong>{branch}</strong> has no commits yet. Save your
                        first commit to create this branch and start new ones
                        from it.
                      </p>
                    </EmptyState>
                  ) : (
                    <>
                      <label className="git-filter git-branch-filter">
                        <Search size={15} />
                        <input
                          aria-label="Filter branches"
                          placeholder="Find a branch…"
                          value={filter}
                          onChange={(event) => setFilter(event.target.value)}
                        />
                      </label>
                      <div className="git-table-heading">
                        <h3>
                          Local branches
                          <span className="git-count">
                            {localBranches.length}
                          </span>
                        </h3>
                        <span>On this computer</span>
                      </div>
                      <div className="git-branch-list">
                        {localBranches
                          .filter((entry) => match(entry.name))
                          .sort((a, b) => Number(b.current) - Number(a.current))
                          .map((entry) => (
                            <div className="git-branch-row" key={entry.name}>
                              <GitBranch
                                size={18}
                                className={
                                  entry.current ? "git-accent" : "muted"
                                }
                              />
                              <div className="git-row-main">
                                <div>
                                  <strong>{entry.name}</strong>
                                  {entry.current && (
                                    <span className="git-tag">
                                      <Check size={11} />
                                      Current
                                    </span>
                                  )}
                                </div>
                                <p className="truncate">{entry.subject}</p>
                                <small>
                                  {entry.upstream
                                    ? "Tracking " + entry.upstream
                                    : "Local only"}
                                </small>
                              </div>
                              <time
                                className="git-row-date"
                                title={new Date(entry.date).toLocaleString()}
                              >
                                {new Date(entry.date).toLocaleDateString(
                                  undefined,
                                  { month: "short", day: "numeric" },
                                )}
                              </time>
                              {!entry.current && (
                                <div className="git-inline-actions">
                                  <button
                                    className="btn"
                                    disabled={disabled || data.mergeInProgress}
                                    onClick={() =>
                                      void act("switchBranch", entry.name)
                                    }
                                  >
                                    Switch
                                    <ArrowRight size={13} />
                                  </button>
                                  <Menu
                                    align="end"
                                    width={245}
                                    trigger={({ toggle, id, open }) => (
                                      <button
                                        id={id}
                                        className="icon-btn"
                                        aria-label={"Actions for " + entry.name}
                                        aria-expanded={open}
                                        aria-haspopup="menu"
                                        disabled={
                                          disabled || data.mergeInProgress
                                        }
                                        onClick={toggle}
                                      >
                                        <MoreHorizontal size={17} />
                                      </button>
                                    )}
                                    items={[
                                      {
                                        id: "merge",
                                        label: "Merge into " + branch,
                                        icon: <GitMerge size={14} />,
                                        onSelect: () =>
                                          showDialog({
                                            operation: "merge",
                                            value: entry.name,
                                            title: "Merge into " + branch + "?",
                                            description:
                                              "Bring commits from " +
                                              entry.name +
                                              " into your current branch, " +
                                              branch +
                                              ".",
                                            label: "Merge branch",
                                          }),
                                      },
                                      {
                                        id: "delete",
                                        label: "Delete branch",
                                        icon: <Trash2 size={14} />,
                                        danger: true,
                                        onSelect: () =>
                                          showDialog({
                                            operation: "deleteBranch",
                                            value: entry.name,
                                            title: "Delete " + entry.name + "?",
                                            description:
                                              "Delete this local branch. Git will keep it if it contains unmerged work.",
                                            label: "Delete branch",
                                            danger: true,
                                          }),
                                      },
                                    ]}
                                  />
                                </div>
                              )}
                            </div>
                          ))}
                      </div>
                      {filter &&
                        !localBranches.some((entry) => match(entry.name)) && (
                          <p className="git-list-hint">
                            No local branches match your search.
                          </p>
                        )}
                      <div className="git-table-heading">
                        <h3>
                          Remote branches
                          <span className="git-count">
                            {remoteBranches.length}
                          </span>
                        </h3>
                        <button
                          className="git-text-button"
                          onClick={() => changeSection("Remotes")}
                        >
                          Manage remotes
                          <ArrowRight size={13} />
                        </button>
                      </div>
                      {remoteBranches.length ? (
                        remoteBranches
                          .filter((entry) => match(entry.name))
                          .map((entry) => (
                            <div className="git-branch-row" key={entry.name}>
                              <Globe2 size={17} className="muted" />
                              <div className="git-row-main">
                                <strong>{entry.name}</strong>
                                <p className="truncate">{entry.subject}</p>
                              </div>
                              <time className="git-row-date">
                                {new Date(entry.date).toLocaleDateString(
                                  undefined,
                                  { month: "short", day: "numeric" },
                                )}
                              </time>
                            </div>
                          ))
                      ) : (
                        <div className="git-inline-empty">
                          <Globe2 size={22} />
                          <div>
                            <strong>No remote branches yet</strong>
                            <p>
                              {data.remotes.length
                                ? "Fetch your remotes to update the branch list."
                                : "Connect a remote repository to see shared branches here."}
                            </p>
                          </div>
                          {data.remotes.length > 0 && (
                            <button
                              className="btn"
                              disabled={disabled}
                              onClick={() => void act("fetch")}
                            >
                              Fetch remotes
                            </button>
                          )}
                        </div>
                      )}
                      {filter &&
                        remoteBranches.length > 0 &&
                        !remoteBranches.some((entry) => match(entry.name)) && (
                          <p className="git-list-hint">
                            No remote branches match your search.
                          </p>
                        )}
                    </>
                  )}
                </div>
              )}

              {section === "Stashes" && (
                <div className="git-stash-layout">
                  <header className="git-section-heading">
                    <div>
                      <p>
                        Set unfinished work aside and restore it when you’re
                        ready.
                      </p>
                    </div>
                    {data.hasCommits && data.stashes.length > 0 && (
                      <button
                        className="btn"
                        data-variant="primary"
                        disabled={
                          disabled || !files.length || conflicts.length > 0
                        }
                        title={
                          !files.length
                            ? "Make a change before saving a stash"
                            : undefined
                        }
                        onClick={saveStash}
                      >
                        <Archive size={15} />
                        Save changes
                      </button>
                    )}
                  </header>
                  {!data.hasCommits ? (
                    <EmptyState
                      icon={Archive}
                      title="Make a first commit to use stashes"
                      action={reviewChanges}
                    >
                      <p>
                        A stash saves work relative to a commit. Create your
                        first commit before setting changes aside.
                      </p>
                    </EmptyState>
                  ) : !data.stashes.length ? (
                    <EmptyState
                      icon={Archive}
                      title="No work set aside"
                      action={
                        files.length ? (
                          <button
                            className="btn"
                            disabled={disabled || conflicts.length > 0}
                            onClick={saveStash}
                          >
                            Save current changes
                          </button>
                        ) : undefined
                      }
                    >
                      <p>
                        Stashes keep unfinished changes while you switch tasks.
                        Applying one restores the files and keeps the saved
                        copy.
                      </p>
                      {!files.length && <p>Your working tree is clean.</p>}
                    </EmptyState>
                  ) : (
                    <div
                      className="git-split"
                      data-detail={selection?.kind === "stash"}
                    >
                      <div className="git-stash-list scroll">
                        {data.stashes.map((entry) => (
                          <button
                            className="git-history-row"
                            key={entry.ref}
                            aria-pressed={
                              selection?.kind === "stash" &&
                              selection.ref === entry.ref
                            }
                            onClick={() =>
                              setSelection({ kind: "stash", ref: entry.ref })
                            }
                          >
                            <Archive size={18} />
                            <span>
                              <strong>{entry.subject}</strong>
                              <small>{entry.ref}</small>
                            </span>
                            <ChevronRight size={14} />
                          </button>
                        ))}
                      </div>
                      <ResizeHandle panel="git" inline />
                      <section
                        className="git-review-pane"
                        aria-label="Stash preview"
                      >
                        {selection?.kind === "stash" && selectedStash ? (
                          <>
                            <header className="git-review-header">
                              <button
                                className="icon-btn git-mobile-back"
                                aria-label="Back to stashes"
                                onClick={() => setSelection(null)}
                              >
                                <ArrowLeft size={17} />
                              </button>
                              <div>
                                <h2>{selectedStash.subject}</h2>
                                <p>
                                  {selectedStash.ref} · Applying keeps this
                                  saved copy
                                </p>
                              </div>
                              <div className="git-inline-actions">
                                <button
                                  className="icon-btn git-danger"
                                  aria-label="Delete stash"
                                  disabled={disabled}
                                  onClick={() =>
                                    showDialog({
                                      operation: "dropStash",
                                      value: selectedStash.ref,
                                      title: "Delete this stash?",
                                      description:
                                        selectedStash.subject +
                                        " will be permanently removed from your saved stashes.",
                                      label: "Delete stash",
                                      danger: true,
                                    })
                                  }
                                >
                                  <Trash2 size={15} />
                                </button>
                                <button
                                  className="btn"
                                  data-variant="primary"
                                  disabled={disabled || conflicts.length > 0}
                                  onClick={() =>
                                    void act("applyStash", selectedStash.ref)
                                  }
                                >
                                  <Archive size={14} />
                                  Apply stash
                                </button>
                              </div>
                            </header>
                            <div className="git-review-scroll scroll">
                              <GitReview
                                projectId={projectId}
                                selection={selection}
                                revision={revision}
                              />
                            </div>
                          </>
                        ) : (
                          <EmptyState icon={Archive} title="Review saved work">
                            <p>
                              Select a stash to inspect its file changes before
                              applying it.
                            </p>
                          </EmptyState>
                        )}
                      </section>
                    </div>
                  )}
                </div>
              )}

              {section === "Remotes" && (
                <div className="git-page scroll">
                  <header className="git-section-heading">
                    <div>
                      <p>Connect repositories and keep your work in sync.</p>
                    </div>
                    {data.remotes.length > 0 && (
                      <button
                        className="btn"
                        disabled={disabled}
                        onClick={addRemote}
                      >
                        <Plus size={15} />
                        Add remote
                      </button>
                    )}
                  </header>
                  {!data.remotes.length ? (
                    <EmptyState
                      icon={Globe2}
                      title="Your work is local"
                      action={
                        <button
                          className="btn"
                          data-variant="primary"
                          disabled={disabled}
                          onClick={addRemote}
                        >
                          <Plus size={15} />
                          Connect a remote
                        </button>
                      }
                    >
                      <p>
                        Add a remote repository to back up your commits and
                        collaborate. Nothing is published until you choose to
                        push.
                      </p>
                    </EmptyState>
                  ) : (
                    <>
                      <div className="git-sync">
                        <div className="git-sync-title">
                          <GitBranch size={20} />
                          <div>
                            <h3>{branch}</h3>
                            <p>
                              {!data.hasCommits
                                ? "Create a first commit before publishing."
                                : upstream
                                  ? "Tracking " + upstream
                                  : branch === "detached"
                                    ? "Switch to a branch before publishing."
                                    : "Publish this branch to set up an upstream."}
                            </p>
                          </div>
                        </div>
                        {upstream && (
                          <div className="git-sync-counts">
                            <span>
                              <ArrowUp size={15} />
                              <strong>{data.status?.ahead ?? 0}</strong>to push
                            </span>
                            <span>
                              <ArrowDown size={15} />
                              <strong>{data.status?.behind ?? 0}</strong>to pull
                            </span>
                          </div>
                        )}
                        <div className="git-inline-actions">
                          <button
                            className="btn"
                            disabled={disabled}
                            onClick={() => void act("fetch")}
                          >
                            <RefreshCw size={14} />
                            Fetch
                          </button>
                          {upstream && (
                            <>
                              <button
                                className="btn"
                                disabled={disabled || data.mergeInProgress}
                                title="Pull with fast-forward only"
                                onClick={() => void act("pull")}
                              >
                                <ArrowDown size={14} />
                                Pull
                              </button>
                              <button
                                className="btn"
                                data-variant="primary"
                                disabled={disabled || data.mergeInProgress}
                                onClick={() =>
                                  showDialog({
                                    operation: "push",
                                    title: "Push commits?",
                                    description:
                                      "Send commits from " +
                                      branch +
                                      " to " +
                                      upstream +
                                      ".",
                                    label: "Push commits",
                                  })
                                }
                              >
                                <ArrowUp size={14} />
                                Push
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="git-table-heading">
                        <h3>
                          Connected repositories
                          <span className="git-count">
                            {data.remotes.length}
                          </span>
                        </h3>
                      </div>
                      {data.remotes.map((remote) => (
                        <div className="git-remote-row" key={remote.name}>
                          <Globe2 size={20} className="muted" />
                          <div className="git-row-main">
                            <strong>{remote.name}</strong>
                            <code>{remote.url}</code>
                          </div>
                          <div className="git-inline-actions">
                            {!upstream?.startsWith(remote.name + "/") &&
                              data.hasCommits &&
                              branch !== "detached" && (
                                <button
                                  className="btn"
                                  data-variant={
                                    !upstream ? "primary" : undefined
                                  }
                                  disabled={disabled || data.mergeInProgress}
                                  onClick={() =>
                                    showDialog({
                                      operation: "publish",
                                      value: remote.name,
                                      title: "Publish " + branch + "?",
                                      description:
                                        "Push this branch to " +
                                        remote.name +
                                        " and use it as the upstream for future pulls and pushes.",
                                      label: "Publish branch",
                                    })
                                  }
                                >
                                  <ArrowUp size={14} />
                                  Publish branch
                                </button>
                              )}
                            <button
                              className="icon-btn git-danger"
                              title={"Remove " + remote.name}
                              disabled={disabled}
                              onClick={() =>
                                showDialog({
                                  operation: "removeRemote",
                                  value: remote.name,
                                  title: "Disconnect " + remote.name + "?",
                                  description:
                                    "Remove this local remote configuration. The repository at " +
                                    remote.url +
                                    " will not be deleted.",
                                  label: "Disconnect remote",
                                  danger: true,
                                })
                              }
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                        </div>
                      ))}
                      <p className="git-page-note">
                        Fetch checks for remote updates. Pull brings them into
                        your branch using fast-forward only.
                      </p>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <footer className="git-footer" role="status">
          <span>
            {busy ? (
              <>
                <LoaderCircle size={13} className="git-spinner" />
                {workingLabels[busy] ?? "Working"}…
              </>
            ) : feedback && !feedback.error ? (
              <>
                <Check size={14} className="git-success" />
                {feedback.text}
              </>
            ) : (
              <>
                <span className="git-connection" data-connected={connected} />
                {connected ? "Local workspace" : "Disconnected"}
              </>
            )}
          </span>
          {data?.repository && (
            <span className="git-footer-summary">
              {files.length
                ? files.length +
                  " changed " +
                  (files.length === 1 ? "file" : "files")
                : "No changes"}
              <span>·</span>
              {data.mergeInProgress
                ? "Merge in progress"
                : staged.length + " staged"}
            </span>
          )}
        </footer>

        {dialog && (
          <GitDialog
            action={dialog}
            busy={Boolean(busy)}
            connected={connected}
            returnFocus={dialogTrigger.current}
            error={feedback?.error ? feedback.text : ""}
            errorDetail={feedback?.error ? feedback.detail : undefined}
            onClose={() => {
              setDialog(null);
              setFeedback(null);
            }}
            onSubmit={async (value, remote) => {
              if (await act(dialog.operation, value, 0, remote))
                setDialog(null);
            }}
          />
        )}
      </div>
    </section>
  );
}
