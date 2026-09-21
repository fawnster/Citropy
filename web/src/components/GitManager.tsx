import { AnimatePresence } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  CircleAlert,
  FolderGit2,
  GitBranch,
  LoaderCircle,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { chooseWorkspace, manageGit } from "../lib/actions.ts";
import { useApp, viewportWidth } from "../lib/store.ts";
import { shortPath } from "../lib/format.ts";
import { currentLocale, useI18n } from "../lib/i18n.ts";
import { groupGitFiles } from "../lib/git-files.ts";
import { SectionSidebar } from "./SectionSidebar.tsx";
import { GitDialog, type GitDialogAction } from "./GitDialog.tsx";
import { GitReview, type GitSelection } from "./GitReview.tsx";
import { EmptyState } from "./git/GitEmptyState.tsx";
import { doneLabels, tabs, workingLabels, type Section } from "./git/labels.ts";
import { isConflict, readableError } from "./git/files.ts";
import { ChangesSection } from "./git/ChangesSection.tsx";
import { HistorySection } from "./git/HistorySection.tsx";
import { BranchesSection } from "./git/BranchesSection.tsx";
import { StashesSection } from "./git/StashesSection.tsx";
import { RemotesSection } from "./git/RemotesSection.tsx";
import type {
  GitOperation,
  GitOverview,
} from "../../../shared/protocol.ts";

type Feedback = { error: boolean; text: string; detail?: string };

export function GitManager({
  sidebarOpen,
  onCloseSidebar,
  onBack,
  navigation,
  onBusyChange,
}: {
  sidebarOpen: boolean;
  onCloseSidebar: () => void;
  onBack: () => void;
  navigation?: ReactNode;
  onBusyChange: (busy: boolean) => void;
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
  useEffect(() => {
    onBusyChange(Boolean(busy));
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
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

  return (
    <section className="section-view" aria-label={t("Git manager")}>
      <SectionSidebar activeItem={section} open={sidebarOpen} title={t("Source control")} onBack={onBack} navigation={navigation}>
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
                <ChangesSection
                  data={data}
                  projectId={projectId}
                  busy={busy}
                  disabled={disabled}
                  feedback={feedback}
                  selection={selection}
                  revision={revision}
                  filter={filter}
                  message={message}
                  description={description}
                  files={files}
                  conflicts={conflicts}
                  staged={staged}
                  unstaged={unstaged}
                  selectedFile={selectedFile}
                  branch={branch}
                  canCommit={Boolean(canCommit)}
                  match={match}
                  t={t}
                  setFilter={setFilter}
                  setSelection={setSelection}
                  setMessage={setMessage}
                  setDescription={setDescription}
                  showDialog={showDialog}
                  act={act}
                />
              )}

              {section === "History" && (
                <HistorySection
                  data={data}
                  projectId={projectId}
                  disabled={disabled}
                  selection={selection}
                  revision={revision}
                  offset={offset}
                  branch={branch}
                  selectedCommit={selectedCommit}
                  reviewChanges={reviewChanges}
                  t={t}
                  setSelection={setSelection}
                  act={act}
                />
              )}

              {section === "Branches" && (
                <BranchesSection
                  data={data}
                  busy={busy}
                  disabled={disabled}
                  filter={filter}
                  branch={branch}
                  localBranches={localBranches}
                  remoteBranches={remoteBranches}
                  reviewChanges={reviewChanges}
                  t={t}
                  setFilter={setFilter}
                  changeSection={changeSection}
                  createBranch={createBranch}
                  match={match}
                  showDialog={showDialog}
                  act={act}
                />
              )}

              {section === "Stashes" && (
                <StashesSection
                  data={data}
                  projectId={projectId}
                  disabled={disabled}
                  selection={selection}
                  revision={revision}
                  files={files}
                  conflicts={conflicts}
                  selectedStash={selectedStash}
                  reviewChanges={reviewChanges}
                  t={t}
                  setSelection={setSelection}
                  showDialog={showDialog}
                  act={act}
                  saveStash={saveStash}
                />
              )}

              {section === "Remotes" && (
                <RemotesSection
                  data={data}
                  disabled={disabled}
                  branch={branch}
                  upstream={upstream}
                  t={t}
                  showDialog={showDialog}
                  act={act}
                  addRemote={addRemote}
                />
              )}
            </>
          )}
        </div>

        <AnimatePresence>{dialog && (
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
        )}</AnimatePresence>
      </div>
    </section>
  );
}
