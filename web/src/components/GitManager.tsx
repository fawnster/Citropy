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
import { currentLocale, useI18n } from "../lib/i18n.ts";
import { FileIcon } from "./FileIcon.tsx";
import { groupGitFiles } from "../lib/git-files.ts";
import { Menu } from "./Menu.tsx";
import { SectionSidebar } from "./SectionSidebar.tsx";
import { WorkspaceSelector } from "./WorkspaceSelector.tsx";
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

function fileLabel(file: GitFile, staged: boolean, t: ReturnType<typeof useI18n>) {
  if (isConflict(file)) return t("Conflict");
  if (file.untracked) return t("New");
  return t(
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

function readableError(error: string, t: ReturnType<typeof useI18n>) {
  if (/unable to auto-detect email|please tell me who you are/i.test(error))
    return t("Set your Git name and email before making a commit.");
  if (/conflict|automatic merge failed/i.test(error))
    return t("Some changes conflict. Review the affected files before continuing.");
  if (/would be overwritten/i.test(error))
    return t("Commit or stash your local changes before switching.");
  if (/not fully merged/i.test(error))
    return t("This branch has unmerged commits. Merge them before deleting the branch.");
  if (/authentication|permission denied|could not read username/i.test(error))
    return t("Git couldn’t authenticate with this remote. Check your Git credentials.");
  return (
    error
      .split("\n")
      .find((line) => line.trim() && !line.startsWith("Command failed:"))
      ?.replace(/^(fatal|error):\s*/i, "") ??
    t("Git couldn’t complete the action.")
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
  navigation,
}: {
  sidebarOpen: boolean;
  onCloseSidebar: () => void;
  onBack: () => void;
  navigation?: ReactNode;
}) {
  const t = useI18n();
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
  const [description, setDescription] = useState("");
  const [filter, setFilter] = useState("");
  const [selection, setSelection] = useState<GitSelection | null>(null);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [dialog, setDialog] = useState<GitDialogAction | null>(null);
  const generation = useRef(0);
  const pending = useRef(false);
  const dialogTrigger = useRef<HTMLElement | null>(null);

  const firstFile = (overview: GitOverview): GitSelection | null => {
    const files = overview.status?.files ?? [];
    const unstaged = files.filter((entry) => entry.untracked || entry.work !== " ");
    const file = files.find(isConflict) ?? groupGitFiles(unstaged, false)[0]?.files[0] ?? groupGitFiles(files, true)[0]?.files[0];
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
            text: readableError(error.message, t),
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
        if (operation === "commit") {
          setMessage("");
          setDescription("");
        }
        try {
          const updated = await manageGit(projectId, "overview");
          if (epoch !== generation.current) return false;
          if (typeof updated !== "string" && "repository" in updated)
            receive(updated, 0);
        } catch (error) {
          if (epoch !== generation.current) return false;
          setFeedback({
            error: true,
            text: t("{message} Refresh to load the latest repository state.", {
              message: t(doneLabels[operation] ?? "Action completed."),
            }),
            detail: (error as Error).message,
          });
          return true;
        }
        setFeedback({
          error: false,
          text: t(doneLabels[operation] ?? "Repository updated."),
        });
      }
      return true;
    } catch (error) {
      if (epoch === generation.current) {
        const detail = (error as Error).message;
        setFeedback({ error: true, text: readableError(detail, t), detail });
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
      title: t("Create a branch"),
      description: t("Your new branch will start from {branch}. Citropy will switch to it after creation.", { branch }),
      label: t("Create and switch"),
      fields: "branch",
    });
  const saveStash = () =>
    showDialog({
      operation: "stash",
      title: t("Save changes for later"),
      description:
        t("Save staged, unstaged, and new files in a stash, then return to a clean working tree."),
      label: t("Save stash"),
      fields: "stash",
    });
  const addRemote = () =>
    showDialog({
      operation: "addRemote",
      title: t("Connect a remote"),
      description:
        t("Link this workspace to an existing remote repository. You choose when to publish your commits."),
      label: t("Add remote"),
      fields: "remote",
    });
  const reviewChanges = (
    <button
      className="btn"
      data-variant="primary"
      onClick={() => changeSection("Changes")}
    >
            {t("Review changes")}
      <ArrowRight size={15} />
    </button>
  );

  const fileList = (title: string, list: GitFile[], inIndex: boolean) => (
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

  return (
    <section className="section-view" aria-label={t("Git manager")}>
      {sidebarOpen && (
        <SectionSidebar title={t("Source control")} onBack={onBack} navigation={navigation} workspace={<WorkspaceSelector disabled={Boolean(busy)} />}>
          {tabs.map(({ name, icon: Icon }) => (
            <button
              className="section-link"
              type="button"
              key={name}
              aria-current={section === name ? "page" : undefined}
              onClick={() => changeSection(name)}
            >
              <Icon size={17} />
              <span>{t(name)}</span>
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
              <h1>{t(section)}</h1>
              <p role="status" title={project?.path}>
                {busy
                  ? `${t(workingLabels[busy] ?? "Working")}…`
                  : feedback && !feedback.error
                    ? feedback.text
                    : project
                  ? shortPath(project.path, home)
                  : t("No workspace selected")}
              </p>
            </div>
          </div>
          <div className="git-repository-state">
            {data?.repository && (
              <div className="git-current-branch">
                <GitBranch size={16} />
                <strong>
                  {branch === "detached" ? t("Detached HEAD") : branch}
                </strong>
                <span>
                  {!data.hasCommits
                    ? t("No commits yet")
                    : upstream
                      ? data.status?.ahead || data.status?.behind
                        ? t("{ahead} ahead · {behind} behind", { ahead: data.status?.ahead ?? 0, behind: data.status?.behind ?? 0 })
                        : t("Up to date")
                      : t("Local branch")}
                </span>
              </div>
            )}
            <button
              className="icon-btn"
              title={t("Refresh repository")}
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
              {t("Connection lost. Your repository will be available when Citropy reconnects.")}
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
                  <summary>{t("Show Git details")}</summary>
                  <pre>{feedback.detail}</pre>
                </details>
              )}
            </div>
            <button
              className="icon-btn"
              aria-label={t("Dismiss error")}
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
              title={t("Choose a workspace")}
              action={
                <button
                  className="btn"
                  data-variant="primary"
                  onClick={chooseWorkspace}
                >
                  {t("Open workspace")}
                </button>
              }
            >
              <p>
                {t("Open a project folder to review changes and manage its Git repository.")}
              </p>
            </EmptyState>
          ) : !data ? (
            busy ? (
              <div className="git-preview-placeholder" role="status">
                <LoaderCircle className="git-spinner" size={24} />
                <p>{t("Reading repository…")}</p>
              </div>
            ) : (
              <EmptyState icon={CircleAlert} title={t("Repository unavailable")}>
                <p>{t("Refresh to try loading this workspace again.")}</p>
                <button
                  className="btn"
                  disabled={disabled}
                  onClick={() => void act("overview")}
                >
                  {t("Try again")}
                </button>
              </EmptyState>
            )
          ) : !data.repository ? (
            <EmptyState
              icon={FolderGit2}
              title={t("Start tracking this project")}
              action={
                <button
                  className="btn"
                  data-variant="primary"
                  disabled={disabled}
                  onClick={() => void act("init")}
                >
                  <Plus size={16} />
                  {t("Initialize repository")}
                </button>
              }
            >
              <p>
                {t("Git keeps a history of your files so you can review changes, save commits, and work on branches.")}
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
                            ? t(conflicts.length === 1 ? "{count} file needs conflict resolution" : "{count} files need conflict resolution", { count: conflicts.length })
                            : t("Ready to finish the merge")}
                        </strong>
                        <p>
                          {conflicts.length
                            ? t("Resolve conflict markers in your files, then stage the resolved changes.")
                            : t("Create a commit to complete this merge.")}
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
                          {t("Abort merge")}
                        </button>
                      )}
                    </div>
                  )}
                  {!data.hasCommits && (
                    <div className="git-first-commit">
                      <GitCommitHorizontal size={18} />
                      <span>
                        <strong>{t("Make your first commit.")}</strong> {t("Review your files, stage the ones to track, then write a commit message.")}
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
                          aria-label={t("Filter changed files")}
                          placeholder={t("Filter files…")}
                          value={filter}
                          onChange={(event) => setFilter(event.target.value)}
                        />
                        {filter && (
                          <button
                            className="icon-btn"
                            aria-label={t("Clear file filter")}
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
                            {t("No files match “{filter}”.", { filter })}
                          </p>
                        )}
                      </div>
                      <form
                        className="git-commit-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (canCommit)
                            void act("commit", [message.trim(), description.trim()].filter(Boolean).join("\n\n"));
                        }}
                      >
                        <label htmlFor="git-commit-message">
                          {t("Commit title")}
                        </label>
                        <input
                          id="git-commit-message"
                          value={message}
                          disabled={busy === "commit"}
                          onChange={(event) => setMessage(event.target.value)}
                          placeholder={
                            data.hasCommits
                              ? t("Summarize the change")
                              : t("Initial commit")
                          }
                        />
                        <label htmlFor="git-commit-description">
                          {t("Description")} <span className="git-optional">{t("Optional")}</span>
                        </label>
                        <textarea
                          id="git-commit-description"
                          rows={3}
                          value={description}
                          disabled={busy === "commit"}
                          onChange={(event) => setDescription(event.target.value)}
                          placeholder={t("Explain why this change was made and any useful details.")}
                        />
                        <div className="git-commit-target">
                          <GitBranch size={13} />
                          <span className="truncate">{branch}</span>
                          <span>{staged.length} {t("staged")}</span>
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
                            ? t("Complete merge")
                            : data.hasCommits
                              ? t("Commit staged changes")
                              : t("Create first commit")}
                        </button>
                      </form>
                    </div>
                    <ResizeHandle panel="git" inline />
                    <section
                      className="git-review-pane"
                      aria-label={t("File preview")}
                    >
                      {selection?.kind === "file" && selectedFile ? (
                        <>
                          <header className="git-review-header">
                            <button
                              className="icon-btn git-mobile-back"
                              aria-label={t("Back to changed files")}
                              onClick={() => setSelection(null)}
                            >
                              <ArrowLeft size={17} />
                            </button>
                            <div>
                              <h2>{selection.path}</h2>
                              <p>
                                {selection.staged
                                  ? t("Staged for commit")
                                  : `${fileLabel(selectedFile, false, t)} · ${t("Unstaged changes")}`}
                              </p>
                            </div>
                            <div className="git-inline-actions">
                              {!selection.staged && (
                                <button
                                  className="icon-btn git-danger"
                                  title={t("Discard changes in ") + selection.path}
                                  disabled={disabled}
                                  onClick={() =>
                                    showDialog({
                                      operation: "discardWorktree",
                                      value: selection.path,
                                      title: selectedFile.untracked
                                        ? "Delete this new file?"
                                        : "Discard unstaged changes?",
                                      description: selectedFile.untracked
                                        ? t("{path} will be permanently deleted.", { path: selection.path })
                                        : t("Unstaged edits to {path} will be lost. Staged changes will be kept.", { path: selection.path }),
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
                                {selection.staged ? "Unstage" : t("Stage file")}
                              </button>
                            </div>
                          </header>
                          <GitReview
                            key={`${selection.staged}:${selection.path}`}
                            projectId={projectId}
                            selection={selection}
                            revision={revision}
                          />
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
                              ? t("Select a file to review")
                              : data.hasCommits
                                ? t("Working tree is clean")
                                : t("Add files to get started")
                          }
                        >
                          <p>
                            {files.length
                              ? t("Choose a file on the left to see exactly what will change.")
                              : data.hasCommits
                                ? t("Your files match the latest commit. New edits will appear here.")
                                : t("Create or copy files into this workspace. They’ll appear here, ready for your first commit.")}
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
                    title={t("Your history starts with a commit")}
                    action={reviewChanges}
                  >
                    <p>
                      {t("Commits are saved checkpoints of your work. Review your changes to create the first one.")}
                    </p>
                  </EmptyState>
                ) : (
                  <div
                    className="git-split"
                    data-detail={selection?.kind === "commit"}
                  >
                    <div className="git-history-list">
                      <header className="git-list-heading">
                        <h2>{t("Commit history")}</h2>
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
                                  currentLocale(),
                                  { month: "short", day: "numeric" },
                                )}
                              </small>
                              <code>{commit.hash.slice(0, 7)}</code>
                            </span>
                            {commit.refs.includes("HEAD") && (
                              <span className="git-tag">{t("Latest")}</span>
                            )}
                          </button>
                        ))}
                        {!data.commits.length && (
                          <p className="git-list-hint">
                            {t("No more commits on this page.")}
                          </p>
                        )}
                      </div>
                      <footer className="git-pagination">
                        <button
                          className="icon-btn"
                          aria-label={t("Previous commits page")}
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
                            : t("End of history")}
                        </span>
                        <button
                          className="icon-btn"
                          aria-label={t("Next commits page")}
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
                      aria-label={t("Commit preview")}
                    >
                      {selection?.kind === "commit" && selectedCommit ? (
                        <>
                          <header className="git-review-header">
                            <button
                              className="icon-btn git-mobile-back"
                              aria-label={t("Back to history")}
                              onClick={() => setSelection(null)}
                            >
                              <ArrowLeft size={17} />
                            </button>
                            <div>
                              <h2>{selectedCommit.subject}</h2>
                              <p>
                                {selectedCommit.author} ·{" "}
                                {new Date(selectedCommit.date).toLocaleString(currentLocale())}{" "}
                                · <code>{selectedCommit.hash.slice(0, 8)}</code>
                              </p>
                              {selectedCommit.refs && (
                                <span className="git-commit-refs">
                                  {selectedCommit.refs}
                                </span>
                              )}
                            </div>
                          </header>
                          <GitReview
                            key={selection.hash}
                            projectId={projectId}
                            selection={selection}
                            revision={revision}
                          />
                        </>
                      ) : (
                        <EmptyState
                          icon={GitCommitHorizontal}
                          title={t("Review a saved change")}
                        >
                          <p>
                            {t("Select a commit to see its message and file changes.")}
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
                        {t("Keep separate lines of work and bring changes together.")}
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
                        {t("New branch")}
                      </button>
                    )}
                  </header>
                  {!data.hasCommits && (
                    <div className="git-current-summary">
                      <GitBranch size={22} />
                      <div>
                        <small>{t("Current branch")}</small>
                        <strong>{branch}</strong>
                      </div>
                      <span className="git-tag">{t("Awaiting first commit")}</span>
                    </div>
                  )}
                  {!data.hasCommits ? (
                    <EmptyState
                      icon={GitBranch}
                      title={t("Create a commit before branching")}
                      action={reviewChanges}
                    >
                      <p>{" "}{t("Your repository is initialized, but")}{" "}
                        <strong>{branch}</strong>{" "}{t("has no commits yet. Save your first commit to create this branch and start new ones from it.")}{" "}</p>
                    </EmptyState>
                  ) : (
                    <>
                      <label className="git-filter git-branch-filter">
                        <Search size={15} />
                        <input
                          aria-label={t("Filter branches")}
                          placeholder={t("Find a branch…")}
                          value={filter}
                          onChange={(event) => setFilter(event.target.value)}
                        />
                      </label>
                      <div className="git-table-heading">
                        <h3>
                          {t("Local branches")}
                          <span className="git-count">
                            {localBranches.length}
                          </span>
                        </h3>
                        <span>{t("On this computer")}</span>
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
                                      {t("Current")}
                                    </span>
                                  )}
                                </div>
                                <p className="truncate">{entry.subject}</p>
                                <small>
                                  {entry.upstream
                                    ? t("Tracking ") + entry.upstream
                                    : t("Local only")}
                                </small>
                              </div>
                              <time
                                className="git-row-date"
                                title={new Date(entry.date).toLocaleString(currentLocale())}
                              >
                                {new Date(entry.date).toLocaleDateString(
                                  currentLocale(),
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
                                    {t("Switch")}
                                    <ArrowRight size={13} />
                                  </button>
                                  <Menu
                                    align="end"
                                    width={245}
                                    trigger={({ toggle, id, open }) => (
                                      <button
                                        id={id}
                                        className="icon-btn"
                                        aria-label={t("Actions for {name}", { name: entry.name })}
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
                                        label: t("Merge into {branch}", { branch }),
                                        icon: <GitMerge size={14} />,
                                        onSelect: () =>
                                          showDialog({
                                            operation: "merge",
                                            value: entry.name,
                                            title: t("Merge into {branch}?", { branch }),
                                            description: t("Bring commits from {source} into your current branch, {branch}.", { source: entry.name, branch }),
                                            label: t("Merge branch"),
                                          }),
                                      },
                                      {
                                        id: "delete",
                                        label: t("Delete branch"),
                                        icon: <Trash2 size={14} />,
                                        danger: true,
                                        onSelect: () =>
                                          showDialog({
                                            operation: "deleteBranch",
                                            value: entry.name,
                                            title: t("Delete {name}?", { name: entry.name }),
                                            description:
                                              "Delete this local branch. Git will keep it if it contains unmerged work.",
                                            label: t("Delete branch"),
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
                            {t("No local branches match your search.")}
                          </p>
                        )}
                      <div className="git-table-heading">
                        <h3>
                          {t("Remote branches")}
                          <span className="git-count">
                            {remoteBranches.length}
                          </span>
                        </h3>
                        <button
                          className="git-text-button"
                          onClick={() => changeSection("Remotes")}
                        >
                            {t("Manage remotes")}
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
                                  currentLocale(),
                                  { month: "short", day: "numeric" },
                                )}
                              </time>
                            </div>
                          ))
                      ) : (
                        <div className="git-inline-empty">
                          <Globe2 size={22} />
                          <div>
                            <strong>{t("No remote branches yet")}</strong>
                            <p>
                              {data.remotes.length
                                ? t("Fetch your remotes to update the branch list.")
                                : t("Connect a remote repository to see shared branches here.")}
                            </p>
                          </div>
                          {data.remotes.length > 0 && (
                            <button
                              className="btn"
                              disabled={disabled}
                              onClick={() => void act("fetch")}
                            >
                              {t("Fetch remotes")}
                            </button>
                          )}
                        </div>
                      )}
                      {filter &&
                        remoteBranches.length > 0 &&
                        !remoteBranches.some((entry) => match(entry.name)) && (
                          <p className="git-list-hint">
                            {t("No remote branches match your search.")}
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
                      <p>{" "}{t("Set unfinished work aside and restore it when you’re ready.")}{" "}</p>
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
                            ? t("Make a change before saving a stash")
                            : undefined
                        }
                        onClick={saveStash}
                      >
                        <Archive size={15} />
                        {t("Save changes")}
                      </button>
                    )}
                  </header>
                  {!data.hasCommits ? (
                    <EmptyState
                      icon={Archive}
                        title={t("Make a first commit to use stashes")}
                      action={reviewChanges}
                    >
                      <p>{" "}{t("A stash saves work relative to a commit. Create your first commit before setting changes aside.")}{" "}</p>
                    </EmptyState>
                  ) : !data.stashes.length ? (
                    <EmptyState
                      icon={Archive}
                      title={t("No work set aside")}
                      action={
                        files.length ? (
                          <button
                            className="btn"
                            disabled={disabled || conflicts.length > 0}
                            onClick={saveStash}
                          >
                            {t("Save current changes")}
                          </button>
                        ) : undefined
                      }
                    >
                      <p>{" "}{t("Stashes keep unfinished changes while you switch tasks. Applying one restores the files and keeps the saved copy.")}{" "}</p>
                      {!files.length && <p>{t("Your working tree is clean.")}</p>}
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
                        aria-label={t("Stash preview")}
                      >
                        {selection?.kind === "stash" && selectedStash ? (
                          <>
                            <header className="git-review-header">
                              <button
                                className="icon-btn git-mobile-back"
                                aria-label={t("Back to stashes")}
                                onClick={() => setSelection(null)}
                              >
                                <ArrowLeft size={17} />
                              </button>
                              <div>
                                <h2>{selectedStash.subject}</h2>
                                <p>
                                  {selectedStash.ref}{" "}{t("· Applying keeps this saved copy")}{" "}</p>
                              </div>
                              <div className="git-inline-actions">
                                <button
                                  className="icon-btn git-danger"
                                  aria-label={t("Delete stash")}
                                  disabled={disabled}
                                  onClick={() =>
                                    showDialog({
                                      operation: "dropStash",
                                      value: selectedStash.ref,
                                      title: "Delete this stash?",
                                      description: t("{stash} will be permanently removed from your saved stashes.", { stash: selectedStash.subject }),
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
                                  {t("Apply stash")}
                                </button>
                              </div>
                            </header>
                            <GitReview
                              key={selection.ref}
                              projectId={projectId}
                              selection={selection}
                              revision={revision}
                            />
                          </>
                        ) : (
                          <EmptyState icon={Archive} title={t("Review saved work")}>
                            <p>{" "}{t("Select a stash to inspect its file changes before applying it.")}{" "}</p>
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
                      <p>{t("Connect repositories and keep your work in sync.")}</p>
                    </div>
                    {data.remotes.length > 0 && (
                      <button
                        className="btn"
                        disabled={disabled}
                        onClick={addRemote}
                      >
                        <Plus size={15} />
                        {t("Add remote")}
                      </button>
                    )}
                  </header>
                  {!data.remotes.length ? (
                    <EmptyState
                      icon={Globe2}
                      title={t("Your work is local")}
                      action={
                        <button
                          className="btn"
                          data-variant="primary"
                          disabled={disabled}
                          onClick={addRemote}
                        >
                          <Plus size={15} />
                          {t("Connect a remote")}
                        </button>
                      }
                    >
                      <p>{" "}{t("Add a remote repository to back up your commits and collaborate. Nothing is published until you choose to push.")}{" "}</p>
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
                                ? t("Create a first commit before publishing.")
                                : upstream
                                  ? t("Tracking ") + upstream
                                  : branch === "detached"
                                    ? t("Switch to a branch before publishing.")
                                    : t("Publish this branch to set up an upstream.")}
                            </p>
                          </div>
                        </div>
                        {upstream && (
                          <div className="git-sync-counts">
                            <span>
                              <ArrowUp size={15} />
                              <strong>{data.status?.ahead ?? 0}</strong>{t("to push")}{" "}</span>
                            <span>
                              <ArrowDown size={15} />
                              <strong>{data.status?.behind ?? 0}</strong>{t("to pull")}{" "}</span>
                          </div>
                        )}
                        <div className="git-inline-actions">
                          <button
                            className="btn"
                            disabled={disabled}
                            onClick={() => void act("fetch")}
                          >
                            <RefreshCw size={14} />
                            {t("Fetch")}
                          </button>
                          {upstream && (
                            <>
                              <button
                                className="btn"
                                disabled={disabled || data.mergeInProgress}
                                title={t("Pull with fast-forward only")}
                                onClick={() => void act("pull")}
                              >
                                <ArrowDown size={14} />
                                {t("Pull")}
                              </button>
                              <button
                                className="btn"
                                data-variant="primary"
                                disabled={disabled || data.mergeInProgress}
                                onClick={() =>
                                  showDialog({
                                    operation: "push",
                                    title: "Push commits?",
                                    description: t("Send commits from {branch} to {upstream}.", { branch, upstream: upstream ?? "" }),
                                    label: "Push commits",
                                  })
                                }
                              >
                                <ArrowUp size={14} />
                                {t("Push")}
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="git-table-heading">
                        <h3>
                        {t("Connected repositories")}
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
                                      title: t("Publish {branch}?", { branch }),
                                      description: t("Push this branch to {remote} and use it as the upstream for future pulls and pushes.", { remote: remote.name }),
                                      label: "Publish branch",
                                    })
                                  }
                                >
                                  <ArrowUp size={14} />
                                  {t("Publish branch")}
                                </button>
                              )}
                            <button
                              className="icon-btn git-danger"
                              title={t("Remove ") + remote.name}
                              disabled={disabled}
                              onClick={() =>
                                showDialog({
                                  operation: "removeRemote",
                                  value: remote.name,
                                  title: t("Disconnect {remote}?", { remote: remote.name }),
                                  description: t("Remove this local remote configuration. The repository at {url} will not be deleted.", { url: remote.url }),
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
                      <p className="git-page-note">{" "}{t("Fetch checks for remote updates. Pull brings them into your branch using fast-forward only.")}{" "}</p>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>

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
