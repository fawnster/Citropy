import { useEffect, useState, type ReactNode } from "react";
import {
  Bell,
  BookOpen,
  Check,
  CircleDot,
  Download,
  FolderGit2,
  GitBranch,
  GitFork,
  Github,
  GitPullRequest,
  LockKeyhole,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  Search,
  Star,
  Tag,
  UserRound,
} from "lucide-react";
import { SectionSidebar } from "../SectionSidebar.tsx";
import { useApp, selectProject, viewportWidth } from "../../lib/store.ts";
import { useGitHub } from "../../lib/use-github.ts";
import { github } from "../../lib/actions.ts";
import { GitHubItems } from "./GitHubItems.tsx";
import { GitHubActions } from "./GitHubActions.tsx";
import { GitHubReleases } from "./GitHubReleases.tsx";
import {
  GitHubDialog,
  GitHubFeedback,
  GitHubLink,
  GitHubPagination,
  formText,
  githubDate,
} from "./GitHubShared.tsx";
import type { GitHubRepository } from "../../../../shared/github.ts";

const sections = [
  { name: "Repositories", icon: BookOpen, global: true },
  { name: "Pull requests", icon: GitPullRequest, global: false },
  { name: "Issues", icon: CircleDot, global: false },
  { name: "Actions", icon: Play, global: false },
  { name: "Releases", icon: Tag, global: false },
  { name: "Notifications", icon: Bell, global: true },
] as const;
type Section = (typeof sections)[number]["name"] | "Account";

export function GitHub({
  sidebarOpen,
  onCloseSidebar,
  onBack,
  onGit,
  navigation,
  status,
}: {
  sidebarOpen: boolean;
  onCloseSidebar: () => void;
  onBack: () => void;
  onGit: () => void;
  navigation?: ReactNode;
  status: ReturnType<typeof useGitHub<"status">>;
}) {
  const connected = useApp((state) => state.connected);
  const projectId = useApp((state) => state.activeProjectId);
  const project = useApp((state) =>
    state.projects.find((project) => project.id === projectId),
  );
  const [section, setSection] = useState<Section>("Repositories");
  const [repo, setRepo] = useState("");
  const repository = useGitHub(
    "repository",
    repo && status.data?.account ? { repo } : null,
  );
  const [clone, setClone] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [fork, setFork] = useState(false);
  const [message, setMessage] = useState("");
  const chooseRepo = (name: string) => {
    setRepo(name);
    setSection("Pull requests");
    setMessage("");
    if (viewportWidth() <= 720) onCloseSidebar();
  };
  useEffect(() => {
    if (!repo && status.data?.repositories[0])
      setRepo(status.data.repositories[0].repo);
  }, [status.data, repo]);
  const global =
    section === "Account" ||
    sections.find((entry) => entry.name === section)?.global;
  return (
    <section className="section-view github-view" aria-label="GitHub">
      {sidebarOpen && (
        <SectionSidebar title="GitHub" onBack={onBack} navigation={navigation}>
          {sections.map(({ name, icon: Icon, global }) => (
            <button
              className="section-link"
              key={name}
              aria-current={section === name ? "page" : undefined}
              disabled={!global && !repo}
              onClick={() => {
                setSection(name);
                if (viewportWidth() <= 720) onCloseSidebar();
              }}
            >
              <Icon size={17} />
              <span>{name}</span>
            </button>
          ))}
          {repo && (
            <div className="github-sidebar-repo">
              <span>Selected repository</span>
              <strong>{repo}</strong>
            </div>
          )}
          <button
            type="button"
            className="github-sidebar-account"
            aria-label={
              status.data?.account
                ? `Account settings for ${status.data.account.login}`
                : "Connect GitHub account"
            }
            aria-current={section === "Account" ? "page" : undefined}
            onClick={() => {
              setSection("Account");
              if (viewportWidth() <= 720) onCloseSidebar();
            }}
          >
            {status.data?.account ? (
              <img src={status.data.account.avatar_url} alt="" />
            ) : (
              <UserRound size={21} />
            )}
            <span>{status.data?.account?.login ?? "Connect GitHub"}</span>
            {status.data?.account && <Check size={14} />}
          </button>
        </SectionSidebar>
      )}
      <div className="github-main">
        <header className="github-heading">
          <div className="github-heading-copy">
            <span className="github-eyebrow">GITHUB</span>
            <h1>{global ? section : repo || section}</h1>
            <p>
              {global
                ? section === "Repositories"
                  ? "Your repositories and the projects you contribute to."
                  : section === "Notifications"
                    ? "Updates that need your attention across GitHub."
                    : "Your GitHub connection on this computer."
                : repository.data?.description || section}
            </p>
          </div>
          {!global && repository.data && (
            <div className="github-repo-actions">
              <button
                className="btn"
                onClick={() => setSection("Repositories")}
              >
                <BookOpen size={15} />
                Browse
              </button>
              <button className="btn" onClick={() => setClone(repo)}>
                <Download size={15} />
                Clone
              </button>
              <GitHubLink href={repository.data.html_url}>GitHub</GitHubLink>
            </div>
          )}
        </header>
        {!connected && (
          <div className="github-connection" role="status">
            <LoaderCircle size={16} className="git-spinner" />
            <span>Reconnecting to Citropy… Your loaded pages will stay here.</span>
          </div>
        )}
        <GitHubFeedback
          error={status.error}
          loading={status.loading && !status.data}
        />
        {message && !status.data?.account && (
          <p className="github-notice" role="status">
            {message}
          </p>
        )}
        {status.data && !status.data.account && (
          <div className="github-connect">
            <Github size={38} />
            <h2>
              {status.data.installed
                ? "Connect your GitHub account"
                : "Install GitHub CLI"}
            </h2>
            <p>
              {status.data.installed
                ? "Citropy uses the GitHub account signed in on this computer. Sign in, then refresh the connection."
                : "Install GitHub CLI to connect repositories, pull requests, and issues."}
            </p>
            {status.data.installed ? (
              <button
                className="btn"
                data-variant="primary"
                onClick={async () => {
                  try {
                    setMessage((await github("authenticate", {})).message);
                  } catch (error) {
                    setMessage((error as Error).message);
                  }
                }}
              >
                Sign in to GitHub
              </button>
            ) : (
              <GitHubLink href="https://cli.github.com/">
                Get GitHub CLI
              </GitHubLink>
            )}
            <button className="btn" onClick={status.refresh}>
              <RefreshCw size={15} />
              Refresh connection
            </button>
            <details>
              <summary>Connection details</summary>
              <pre>{status.data.error}</pre>
            </details>
          </div>
        )}
        {status.data?.account && (
          <>
            {message && (
              <p className="github-notice" role="status">
                {message}
              </p>
            )}
            {section === "Repositories" && (
              <RepositoryBrowser
                onSelect={chooseRepo}
                onClone={setClone}
                workspace={status.data.repositories.map(
                  (remote) => remote.repo,
                )}
                workspaceName={project?.name}
                projectId={projectId ?? undefined}
                hasCommits={Boolean(status.data.hasCommits)}
                onGit={onGit}
              />
            )}
            {section === "Notifications" && (
              <Notifications onSelect={chooseRepo} />
            )}
            {section === "Account" && (
              <div className="github-account scroll">
                <div className="github-account-identity">
                  <img src={status.data.account.avatar_url} alt="" />
                  <div>
                    <h2>
                      {status.data.account.name || status.data.account.login}
                    </h2>
                    <p>@{status.data.account.login}</p>
                  </div>
                  <span className="github-state" data-tone="good">
                    <Check size={16} />
                    Connected
                  </span>
                </div>
                <div className="github-account-details">
                  <div>
                    <strong>GitHub host</strong>
                    <span>github.com</span>
                  </div>
                  <div>
                    <strong>Authentication</strong>
                    <span>GitHub CLI on this computer</span>
                  </div>
                  <div>
                    <strong>Workspace</strong>
                    <span>
                      {status.data.repositories[0]?.repo ??
                        "No GitHub remote connected"}
                    </span>
                  </div>
                </div>
                <p className="github-meta">
                  Citropy uses your existing GitHub permissions. Credentials stay
                  on this computer and are never sent to the browser.
                </p>
                <div className="github-detail-actions">
                  <button
                    className="btn"
                    onClick={status.refresh}
                    disabled={status.loading}
                  >
                    <RefreshCw size={14} />
                    Refresh connection
                  </button>
                  <GitHubLink href="https://github.com/settings/profile">
                    Manage account
                  </GitHubLink>
                </div>
              </div>
            )}
            {!global && (
              <>
                <GitHubFeedback
                  error={repository.error}
                  loading={repository.loading && !repository.data}
                />
                {repository.data && (
                  <>
                    <div className="github-repo-metadata">
                      <span>
                        <GitBranch size={14} />
                        {repository.data.default_branch}
                      </span>
                      <span>
                        <Star size={14} />
                        {repository.data.stargazers_count}
                      </span>
                      <span>
                        <GitFork size={14} />
                        {repository.data.forks_count}
                      </span>
                      <span>
                        {repository.data.private ? "Private" : "Public"}
                      </span>
                      {repository.data.archived && <span>Archived</span>}
                      {projectId &&
                        !status.data.repositories.some(
                          (remote) => remote.repo === repo,
                        ) && (
                          <button onClick={() => setConnecting(true)}>
                            Connect workspace
                          </button>
                        )}
                      <button onClick={() => setFork(true)}>
                        Fork repository
                      </button>
                    </div>
                    {section === "Pull requests" || section === "Issues" ? (
                      <GitHubItems
                        key={`${repo}-${section}`}
                        repository={repository.data}
                        currentUser={status.data.account.login}
                        pull={section === "Pull requests"}
                        branch={
                          status.data.repositories.some(
                            (remote) => remote.repo === repo,
                          )
                            ? status.data.branch
                            : undefined
                        }
                      />
                    ) : section === "Actions" ? (
                      <GitHubActions key={repo} repository={repository.data} />
                    ) : (
                      <GitHubReleases key={repo} repository={repository.data} />
                    )}
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
      {clone && (
        <GitHubDialog
          title="Clone repository"
          description={`Clone ${clone} into a new folder named ${clone.split("/")[1]}. Choose its parent folder in the system file explorer.`}
          submitLabel="Choose folder and clone"
          onClose={() => setClone(null)}
          onSubmit={async () => {
            const result = await github("clone", { repo: clone });
            if (result.project) {
              selectProject(result.project.id);
              onBack();
            }
          }}
        >
          <p className="github-meta">
            The repository will open as a workspace when the clone finishes.
            Existing folders will be preserved.
          </p>
        </GitHubDialog>
      )}
      {connecting && projectId && (
        <GitHubDialog
          title="Connect workspace"
          description={`Connect ${project?.name} to ${repo}. This adds a Git remote without pulling or pushing any files.`}
          submitLabel="Connect repository"
          onClose={() => setConnecting(false)}
          onSubmit={async (data) => {
            setMessage(
              (
                await github("connectRepository", {
                  projectId,
                  repo,
                  remote: formText(data, "remote"),
                })
              ).message,
            );
            status.refresh();
          }}
        >
          <label className="git-field">
            Remote name
            <input name="remote" defaultValue="origin" required />
          </label>
        </GitHubDialog>
      )}
      {fork && (
        <GitHubDialog
          title="Fork repository"
          description={`Create a copy of ${repo} in your GitHub account.`}
          submitLabel="Create fork"
          onClose={() => setFork(false)}
          onSubmit={async () => {
            const result = await github("mutate", {
              repo,
              mutation: { action: "fork" },
            });
            setMessage(result.message);
            repository.refresh();
          }}
        />
      )}
    </section>
  );
}

function RepositoryBrowser({
  onSelect,
  onClone,
  workspace,
  workspaceName,
  projectId,
  hasCommits,
  onGit,
}: {
  onSelect: (repo: string) => void;
  onClone: (repo: string) => void;
  workspace: string[];
  workspaceName?: string;
  projectId?: string;
  hasCommits: boolean;
  onGit: () => void;
}) {
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [creating, setCreating] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const list = useGitHub("repositories", { page, query: search, scope });
  return (
    <div className="github-workspace scroll">
      {projectId && !workspace.length && (
        <div className="github-local-workspace">
          <FolderGit2 size={21} />
          <div>
            <strong>{workspaceName}</strong>
            <p>
              {hasCommits
                ? "Publish this workspace, or choose a repository and connect it."
                : "Create your first commit in Source control before publishing this workspace."}
            </p>
          </div>
          <button className="btn" onClick={onGit}>
            Source control
          </button>
          <button
            className="btn"
            disabled={!hasCommits}
            onClick={() => {
              setPublishing(true);
              setCreating(true);
            }}
          >
            Publish workspace
          </button>
        </div>
      )}
      {workspace.length > 0 && (
        <div className="github-workspace-repos">
          <span>{workspaceName} workspace</span>
          {workspace.map((repo) => (
            <button className="btn" key={repo} onClick={() => onSelect(repo)}>
              <FolderGit2 size={15} />
              {repo}
            </button>
          ))}
        </div>
      )}
      <div className="github-toolbar">
        <form
          className="github-search"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(query);
            setPage(1);
          }}
        >
          <Search size={16} />
          <input
            aria-label="Search repositories"
            placeholder={
              scope === "mine" ? "Find a repository…" : "Search all of GitHub…"
            }
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button className="btn">Search</button>
        </form>
        <select
          aria-label="Repository scope"
          value={scope}
          onChange={(event) => {
            setScope(event.target.value as typeof scope);
            setPage(1);
          }}
        >
          <option value="mine">Your repositories</option>
          <option value="all">All GitHub</option>
        </select>
        <button
          className="icon-btn"
          aria-label="Refresh repositories"
          disabled={list.loading}
          onClick={list.refresh}
        >
          <RefreshCw size={16} />
        </button>
        <button
          className="btn"
          data-variant="primary"
          onClick={() => {
            setPublishing(false);
            setCreating(true);
          }}
        >
          <Plus size={15} />
          New repository
        </button>
      </div>
      <GitHubFeedback
        error={list.error}
        loading={list.loading && !list.data}
        empty={
          list.data?.items.length === 0 ? "No repositories found" : undefined
        }
      />
      <div className="github-repositories">
        {list.data?.items.map((repo: GitHubRepository) => (
          <article key={repo.id}>
            <img
              className="github-repository-icon"
              src={repo.owner.avatar_url}
              alt={`${repo.owner.login} avatar`}
              loading="lazy"
              width={36}
              height={36}
            />
            <button
              className="github-repository-copy"
              onClick={() => onSelect(repo.full_name)}
            >
              <strong>{repo.full_name}</strong>
              {repo.description && <p>{repo.description}</p>}
              <div className="github-meta">
                {repo.private ? (
                  <span>
                    <LockKeyhole size={12} />
                    Private
                  </span>
                ) : (
                  <span>Public</span>
                )}
                {repo.language && <span>{repo.language}</span>}
                {repo.fork && <span>Fork</span>}
                {repo.archived && <span>Archived</span>}
                <span>Updated {githubDate(repo.updated_at)}</span>
              </div>
            </button>
            <button className="btn" onClick={() => onClone(repo.full_name)}>
              <Download size={14} />
              Clone
            </button>
          </article>
        ))}
      </div>
      {list.data && (
        <GitHubPagination
          page={page}
          more={list.data.more}
          onChange={setPage}
        />
      )}
      {creating && (
        <GitHubDialog
          title={publishing ? "Publish workspace" : "Create repository"}
          description={
            publishing
              ? `Create a GitHub repository for ${workspaceName} and push the current branch. Only committed files are published.`
              : "Create a repository in your GitHub account with an initial README. You can clone it after creation."
          }
          submitLabel={publishing ? "Create and publish" : "Create repository"}
          onClose={() => setCreating(false)}
          onSubmit={async (data) => {
            const input = {
              name: formText(data, "name"),
              description: formText(data, "description"),
              private: formText(data, "visibility") === "private",
            };
            const result =
              publishing && projectId
                ? await github("publishRepository", { ...input, projectId })
                : await github("createRepository", input);
            onSelect(result.full_name);
          }}
        >
          <label className="git-field">
            Repository name
            <input
              name="name"
              placeholder="my-project"
              required
              pattern="[A-Za-z0-9_.\-]+"
            />
          </label>
          <label className="git-field">
            Description
            <textarea name="description" rows={3} />
          </label>
          <label className="git-field">
            Visibility
            <select name="visibility" defaultValue="private">
              <option value="private">Private</option>
              <option value="public">Public</option>
            </select>
          </label>
        </GitHubDialog>
      )}
    </div>
  );
}

function Notifications({ onSelect }: { onSelect: (repo: string) => void }) {
  const [page, setPage] = useState(1);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const list = useGitHub("notifications", { page, all });
  return (
    <div className="github-workspace scroll">
      <div className="github-toolbar">
        <label className="github-checkbox">
          <input
            type="checkbox"
            checked={all}
            onChange={(event) => {
              setAll(event.target.checked);
              setPage(1);
            }}
          />
          Include read notifications
        </label>
        <button
          className="icon-btn"
          aria-label="Refresh notifications"
          disabled={list.loading}
          onClick={list.refresh}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      <GitHubFeedback
        error={error || list.error}
        loading={list.loading && !list.data}
        empty={
          list.data?.items.length === 0 ? "You’re all caught up" : undefined
        }
      />
      <div className="github-notifications">
        {list.data?.items.map((notification) => (
          <article key={notification.id} data-unread={notification.unread}>
            <Bell size={17} />
            <div>
              <strong>{notification.subject.title}</strong>
              <p className="github-meta">
                <button
                  onClick={() => onSelect(notification.repository.full_name)}
                >
                  {notification.repository.full_name}
                </button>{" "}
                · {notification.reason.replaceAll("_", " ")} ·{" "}
                {githubDate(notification.updated_at)}
              </p>
            </div>
            <GitHubLink
              href={`https://github.com/notifications?query=repo%3A${encodeURIComponent(notification.repository.full_name)}`}
            >
              Open
            </GitHubLink>
            {notification.unread && (
              <button
                className="icon-btn"
                disabled={Boolean(busy)}
                title="Mark as read"
                aria-label={`Mark ${notification.subject.title} as read`}
                onClick={async () => {
                  setBusy(notification.id);
                  setError("");
                  try {
                    await github("mutate", {
                      repo: notification.repository.full_name,
                      mutation: { action: "markRead", id: notification.id },
                    });
                    list.refresh();
                  } catch (failure) {
                    setError((failure as Error).message);
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                <Check size={16} />
              </button>
            )}
          </article>
        ))}
      </div>
      {list.data && (
        <GitHubPagination
          page={page}
          more={list.data.more}
          onChange={setPage}
        />
      )}
    </div>
  );
}
