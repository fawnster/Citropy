import { execFile, spawn } from "node:child_process";
import { stat, mkdir, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { chooseFolder } from "./folder-picker.ts";
import { remoteId, workspaceDirectory } from "./remote.ts";
import { store } from "./store.ts";
import type {
  GitHubRequest,
  GitHubResponse,
  GitHubRepository,
  GitHubStatus,
  GitHubItem,
  GitHubComment,
  GitHubFile,
  GitHubCheck,
  GitHubRun,
  GitHubJob,
  GitHubRelease,
  GitHubNotification,
  GitHubMutation,
  GitHubUser,
} from "../shared/github.ts";

const environment = {
  ...process.env,
  GH_PROMPT_DISABLED: "1",
  GH_HOST: "github.com",
  GH_PAGER: "cat",
  NO_COLOR: "1",
  GIT_TERMINAL_PROMPT: "0",
};

function command(
  binary: string,
  args: string[],
  input?: unknown,
  cwd?: string,
  timeout = 60_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      args,
      { cwd, timeout, maxBuffer: 12 * 1024 * 1024, env: environment },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return reject(
            new Error(`${binary} is not installed on this computer.`),
          );
        const detail = stderr
          .trim()
          .replace(
            /gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+/g,
            "[redacted]",
          );
        reject(
          new Error(
            error.killed
              ? "GitHub request timed out. Refresh to check the result before retrying."
              : detail || error.message,
          ),
        );
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(input === undefined ? undefined : JSON.stringify(input));
  });
}

async function api<T>(
  endpoint: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const output = await command(
    "gh",
    [
      "api",
      "--hostname",
      "github.com",
      "--method",
      method,
      endpoint,
      ...(body === undefined ? [] : ["--input", "-"]),
    ],
    body,
  );
  return (output.trim() ? JSON.parse(output) : undefined) as T;
}

async function all<T>(endpoint: string, key?: string): Promise<T[]> {
  const output = await command("gh", [
    "api",
    "--hostname",
    "github.com",
    "--paginate",
    "--slurp",
    endpoint,
  ]);
  const pages = JSON.parse(output) as Array<T[] | Record<string, T[]>>;
  return pages.flatMap((page) =>
    key ? ((page as Record<string, T[]>)[key] ?? []) : (page as T[]),
  );
}

export function repositoryName(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(value) ||
    [".", ".."].includes(value.split("/")[1]!)
  )
    throw new Error("Choose a GitHub repository in owner/name format.");
  return value;
}

export function repositoryFromRemote(value: string): string | null {
  const match =
    /^(?:https?:\/\/(?:[^/@]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)\/?$/i.exec(
      value.trim(),
    );
  if (!match) return null;
  try {
    return repositoryName(match[1]!.replace(/\.git$/, ""));
  } catch {
    return null;
  }
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("Invalid GitHub item number.");
  return value;
}

function text(value: string, label: string, required = false): string {
  if (
    typeof value !== "string" ||
    value.length > 65_000 ||
    value.includes("\0") ||
    (required && !value.trim())
  )
    throw new Error(`Enter a valid ${label}.`);
  return value;
}

function names(value: string[]): string[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new Error("Too many names.");
  return value.map((name) => text(name, "name", true).trim());
}

function pageNumber(value?: number) {
  return positive(value ?? 1);
}

async function status(projectId?: string): Promise<GitHubStatus> {
  const result: GitHubStatus = { installed: false, repositories: [] };
  try {
    await command("gh", ["--version"]);
    result.installed = true;
    result.account = await api<GitHubUser>("user");
  } catch (error) {
    result.error = (error as Error).message;
  }
  const project = projectId ? store.projects.get(projectId) : undefined;
  if (project) {
    try {
      const output = await command(
        "git",
        ["remote", "-v"],
        undefined,
        project.path,
      );
      const seen = new Set<string>();
      for (const line of output.split("\n")) {
        const [name, url, direction] = line.split(/\s+/);
        const repo = url ? repositoryFromRemote(url) : null;
        if (name && repo && direction === "(fetch)" && !seen.has(repo)) {
          result.repositories.push({ name, repo });
          seen.add(repo);
        }
      }
      result.repositories.sort(
        (a, b) => Number(b.name === "origin") - Number(a.name === "origin"),
      );
      result.hasCommits = await command(
        "git",
        ["rev-parse", "--verify", "HEAD"],
        undefined,
        project.path,
      ).then(
        () => true,
        () => false,
      );
      result.branch = (
        await command(
          "git",
          ["branch", "--show-current"],
          undefined,
          project.path,
        )
      ).trim();
    } catch {}
  }
  return result;
}

async function mutate(
  repo: string,
  mutation: GitHubMutation,
): Promise<{ message: string; url?: string }> {
  const prefix = `repos/${repositoryName(repo)}`;
  switch (mutation.action) {
    case "createIssue": {
      const item = await api<GitHubItem>(`${prefix}/issues`, "POST", {
        title: text(mutation.title, "title", true),
        body: text(mutation.body, "description"),
        labels: names(mutation.labels),
        assignees: names(mutation.assignees),
      });
      return { message: `Issue #${item.number} created.`, url: item.html_url };
    }
    case "createPull": {
      const item = await api<GitHubItem>(`${prefix}/pulls`, "POST", {
        title: text(mutation.title, "title", true),
        body: text(mutation.body, "description"),
        head: text(mutation.head, "head branch", true),
        base: text(mutation.base, "base branch", true),
        draft: Boolean(mutation.draft),
      });
      return {
        message: `Pull request #${item.number} created.`,
        url: item.html_url,
      };
    }
    case "editItem":
      await api(`${prefix}/issues/${positive(mutation.number)}`, "PATCH", {
        title: text(mutation.title, "title", true),
        body: text(mutation.body, "description"),
        labels: names(mutation.labels),
        assignees: names(mutation.assignees),
      });
      return { message: "Changes saved on GitHub." };
    case "comment":
      await api(
        `${prefix}/issues/${positive(mutation.number)}/comments`,
        "POST",
        { body: text(mutation.body, "comment", true) },
      );
      return { message: "Comment posted." };
    case "state":
      if (!["open", "closed"].includes(mutation.state))
        throw new Error("Invalid state.");
      await api(
        `${prefix}/${mutation.pull ? "pulls" : "issues"}/${positive(mutation.number)}`,
        "PATCH",
        { state: mutation.state },
      );
      return {
        message:
          mutation.state === "open"
            ? "Reopened on GitHub."
            : "Closed on GitHub.",
      };
    case "review":
      if (!["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(mutation.event))
        throw new Error("Invalid review.");
      await api(
        `${prefix}/pulls/${positive(mutation.number)}/reviews`,
        "POST",
        {
          event: mutation.event,
          body: text(mutation.body, "review", mutation.event !== "APPROVE"),
          commit_id: text(mutation.sha, "commit", true),
        },
      );
      return { message: "Review submitted." };
    case "merge": {
      if (
        !["merge", "squash", "rebase"].includes(mutation.method) ||
        !/^[0-9a-f]{40,64}$/i.test(mutation.sha)
      )
        throw new Error("Refresh the pull request before merging.");
      const result = await api<{ merged: boolean; message: string }>(
        `${prefix}/pulls/${positive(mutation.number)}/merge`,
        "PUT",
        { merge_method: mutation.method, sha: mutation.sha },
      );
      if (!result.merged)
        throw new Error(
          result.message || "GitHub did not merge the pull request.",
        );
      return { message: "Pull request merged." };
    }
    case "ready":
      await command("gh", [
        "pr",
        "ready",
        String(positive(mutation.number)),
        "--repo",
        repo,
      ]);
      return { message: "Pull request marked ready for review." };
    case "requestReview":
      await api(
        `${prefix}/pulls/${positive(mutation.number)}/requested_reviewers`,
        "POST",
        { reviewers: names(mutation.reviewers) },
      );
      return { message: "Review requested." };
    case "rerun":
      await api(
        `${prefix}/actions/runs/${positive(mutation.id)}/${mutation.failedOnly ? "rerun-failed-jobs" : "rerun"}`,
        "POST",
      );
      return { message: "Workflow rerun requested." };
    case "cancelRun":
      await api(
        `${prefix}/actions/runs/${positive(mutation.id)}/cancel`,
        "POST",
      );
      return { message: "Workflow cancellation requested." };
    case "dispatch":
      if (
        !mutation.inputs ||
        typeof mutation.inputs !== "object" ||
        Array.isArray(mutation.inputs) ||
        Object.keys(mutation.inputs).length > 25 ||
        Object.values(mutation.inputs).some(
          (value) => typeof value !== "string",
        )
      )
        throw new Error(
          "Workflow inputs must be a JSON object with text values.",
        );
      await api(
        `${prefix}/actions/workflows/${positive(mutation.id)}/dispatches`,
        "POST",
        {
          ref: text(mutation.ref, "branch or tag", true),
          inputs: mutation.inputs,
        },
      );
      return { message: "Workflow started. It may take a moment to appear." };
    case "fork": {
      const fork = await api<GitHubRepository>(`${prefix}/forks`, "POST");
      return {
        message: `Fork created: ${fork.full_name}.`,
        url: fork.html_url,
      };
    }
    case "markRead":
      if (!/^\d+$/.test(mutation.id)) throw new Error("Invalid notification.");
      await api(`notifications/threads/${mutation.id}`, "PATCH");
      return { message: "Notification marked as read." };
    case "createRelease": {
      const release = await api<GitHubRelease>(`${prefix}/releases`, "POST", {
        tag_name: text(mutation.tag, "tag", true),
        target_commitish: text(mutation.target, "branch or commit", true),
        name: text(mutation.name, "release name", true),
        body: text(mutation.body, "release notes"),
        draft: Boolean(mutation.draft),
        prerelease: Boolean(mutation.prerelease),
      });
      return {
        message: mutation.draft ? "Release draft saved." : "Release published.",
        url: release.html_url,
      };
    }
    default:
      throw new Error("Unsupported GitHub action.");
  }
}

export async function handleGitHub(
  request: GitHubRequest,
): Promise<GitHubResponse> {
  if ("repo" in request) repositoryName(request.repo);
  switch (request.operation) {
    case "status":
      return status(request.projectId);
    case "authenticate":
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          "konsole",
          [
            "--separate",
            "-e",
            "gh",
            "auth",
            "login",
            "--hostname",
            "github.com",
            "--git-protocol",
            "https",
            "--web",
          ],
          { detached: true, stdio: "ignore", env: process.env },
        );
        child.once("error", () =>
          reject(
            new Error(
              "Could not open the sign-in window. Run gh auth login in your terminal, then refresh.",
            ),
          ),
        );
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      });
      return {
        message:
          "Complete sign-in in the terminal window, then refresh the connection.",
      };
    case "repository":
      return api<GitHubRepository>(`repos/${request.repo}`);
    case "repositories": {
      const page = pageNumber(request.page);
      if (request.scope === "all") {
        const q = text(request.query?.trim() || "stars:>100", "search");
        const result = await api<{
          items: GitHubRepository[];
          total_count: number;
        }>(
          `search/repositories?${new URLSearchParams({ q, per_page: "30", page: String(page), sort: "updated" })}`,
        );
        return {
          items: result.items,
          total: result.total_count,
          more: page * 30 < Math.min(result.total_count, 1000),
        };
      }
      if (request.query?.trim()) {
        const query = text(request.query.trim(), "search").toLowerCase();
        const repos = await all<GitHubRepository>(
          "user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
        );
        const matched = repos.filter((repo) =>
          `${repo.full_name} ${repo.description ?? ""}`
            .toLowerCase()
            .includes(query),
        );
        return {
          items: matched.slice((page - 1) * 30, page * 30),
          total: matched.length,
          more: page * 30 < matched.length,
        };
      }
      const items = await api<GitHubRepository[]>(
        `user/repos?per_page=30&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`,
      );
      return { items, more: items.length === 30 };
    }
    case "items": {
      if (!["open", "closed", "all"].includes(request.state))
        throw new Error("Invalid filter.");
      const page = pageNumber(request.page);
      const q = [
        `repo:${request.repo}`,
        `is:${request.pull ? "pr" : "issue"}`,
        request.state === "all" ? "" : `is:${request.state}`,
        text(request.query ?? "", "search"),
      ]
        .filter(Boolean)
        .join(" ");
      const result = await api<{ items: GitHubItem[]; total_count: number }>(
        `search/issues?${new URLSearchParams({ q, per_page: "30", page: String(page), sort: "updated" })}`,
      );
      return {
        items: result.items,
        total: result.total_count,
        more: page * 30 < Math.min(result.total_count, 1000),
      };
    }
    case "detail": {
      const prefix = `repos/${request.repo}`;
      const number = positive(request.number);
      const [item, comments] = await Promise.all([
        api<GitHubItem>(
          `${prefix}/${request.pull ? "pulls" : "issues"}/${number}`,
        ),
        all<GitHubComment>(`${prefix}/issues/${number}/comments?per_page=100`),
      ]);
      if (!request.pull)
        return {
          item,
          comments,
          reviews: [],
          files: [],
          checks: [],
          statuses: [],
        };
      const sha = item.head!.sha;
      const [reviews, files, checks, statuses] = await Promise.all([
        all<GitHubComment>(`${prefix}/pulls/${number}/reviews?per_page=100`),
        all<GitHubFile>(`${prefix}/pulls/${number}/files?per_page=100`),
        all<GitHubCheck>(
          `${prefix}/commits/${sha}/check-runs?per_page=100`,
          "check_runs",
        ),
        all<{
          id: number;
          context: string;
          state: string;
          target_url: string | null;
        }>(`${prefix}/commits/${sha}/status?per_page=100`, "statuses"),
      ]);
      return { item, comments, reviews, files, checks, statuses };
    }
    case "runs": {
      const result = await api<{
        workflow_runs: GitHubRun[];
        total_count: number;
      }>(
        `repos/${request.repo}/actions/runs?${new URLSearchParams({ per_page: "30", page: String(pageNumber(request.page)), ...(request.branch ? { branch: text(request.branch, "branch") } : {}) })}`,
      );
      return {
        items: result.workflow_runs,
        total: result.total_count,
        more: pageNumber(request.page) * 30 < result.total_count,
      };
    }
    case "run": {
      const id = positive(request.id);
      const [run, jobs] = await Promise.all([
        api<GitHubRun>(`repos/${request.repo}/actions/runs/${id}`),
        all<GitHubJob>(
          `repos/${request.repo}/actions/runs/${id}/jobs?per_page=100`,
          "jobs",
        ),
      ]);
      return { run, jobs };
    }
    case "logs":
      return command("gh", [
        "run",
        "view",
        "--job",
        String(positive(request.jobId)),
        "--log",
        "--repo",
        request.repo,
      ]);
    case "workflows":
      return all<{
        id: number;
        name: string;
        path: string;
        state: string;
        html_url: string;
      }>(`repos/${request.repo}/actions/workflows?per_page=100`, "workflows");
    case "branches": {
      const branches = await all<{ name: string }>(
        `repos/${request.repo}/branches?per_page=100`,
      );
      return branches.map((branch) => branch.name);
    }
    case "releases": {
      const items = await api<GitHubRelease[]>(
        `repos/${request.repo}/releases?per_page=30&page=${pageNumber(request.page)}`,
      );
      return { items, more: items.length === 30 };
    }
    case "notifications": {
      const items = await api<GitHubNotification[]>(
        `notifications?per_page=30&page=${pageNumber(request.page)}&all=${Boolean(request.all)}`,
      );
      return { items, more: items.length === 30 };
    }
    case "clone": {
      const repo = repositoryName(request.repo);
      if (remoteId && !request.parent) throw new Error("Choose a destination folder on the SSH host.");
      const parent = request.parent ? await workspaceDirectory(request.parent) : await chooseFolder(
        "Choose where to clone this repository",
      );
      if (!parent) return { project: null };
      if (!(await stat(parent)).isDirectory())
        throw new Error("Choose a destination folder.");
      const destination = join(parent, repo.split("/")[1]!);
      await mkdir(destination).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST")
          throw new Error(
            "A folder with this repository name already exists. Choose a different parent folder or open the existing workspace.",
          );
        throw error;
      });
      try {
        await command(
          "gh",
          ["repo", "clone", repo, destination],
          undefined,
          parent,
          180_000,
        );
      } catch (error) {
        await rmdir(destination).catch(() => {});
        throw error;
      }
      return { project: store.openProject(destination) };
    }

    case "connectRepository": {
      const project = store.projects.get(request.projectId);
      if (!project) throw new Error("Workspace not found.");
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.remote))
        throw new Error("Enter a valid remote name.");
      await api<GitHubRepository>(`repos/${request.repo}`);
      await command(
        "git",
        [
          "remote",
          "add",
          request.remote,
          `https://github.com/${request.repo}.git`,
        ],
        undefined,
        project.path,
      );
      return {
        message: `${request.repo} connected as ${request.remote}. Fetch or push from Source control when you are ready.`,
      };
    }
    case "publishRepository": {
      const project = store.projects.get(request.projectId);
      if (!project) throw new Error("Workspace not found.");
      const name = text(request.name, "repository name", true);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
        throw new Error("Enter a valid repository name.");
      await command(
        "git",
        ["rev-parse", "--verify", "HEAD"],
        undefined,
        project.path,
      ).catch(() => {
        throw new Error(
          "Create your first commit in Source control before publishing.",
        );
      });
      const remotes = (
        await command("git", ["remote"], undefined, project.path)
      )
        .trim()
        .split("\n");
      if (remotes.includes("origin"))
        throw new Error(
          "This workspace already has an origin remote. Manage it in Source control before publishing a new repository.",
        );
      const branch = (
        await command(
          "git",
          ["branch", "--show-current"],
          undefined,
          project.path,
        )
      ).trim();
      if (!branch)
        throw new Error(
          "Switch to a branch in Source control before publishing.",
        );
      const account = await api<GitHubUser>("user");
      try {
        await command(
          "gh",
          [
            "repo",
            "create",
            name,
            request.private ? "--private" : "--public",
            "--description",
            text(request.description, "description"),
            "--source",
            project.path,
            "--remote",
            "origin",
            "--push",
          ],
          undefined,
          project.path,
          180_000,
        );
      } catch (error) {
        throw new Error(
          `${(error as Error).message}\nIf the repository was created, open ${account.login}/${name} and use Source control to finish pushing. Avoid creating it again.`,
        );
      }
      return api<GitHubRepository>(`repos/${account.login}/${name}`);
    }
    case "createRepository": {
      const name = text(request.name, "repository name", true);
      if (!/^[A-Za-z0-9_.-]+$/.test(name) || [".", ".."].includes(name))
        throw new Error(
          "Use letters, numbers, dots, hyphens, or underscores in the repository name.",
        );
      return api<GitHubRepository>("user/repos", "POST", {
        name,
        description: text(request.description, "description"),
        private: Boolean(request.private),
        auto_init: true,
      });
    }
    case "mutate":
      return mutate(request.repo, request.mutation);
    default:
      throw new Error("Unsupported GitHub request.");
  }
}
