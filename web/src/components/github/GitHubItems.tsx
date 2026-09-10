import { ResizeHandle } from "../ResizeHandle.tsx";
import { useState } from "react";
import {
  ArrowLeft,
  Check,
  FileCode2,
  GitBranch,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import { useGitHub } from "../../lib/use-github.ts";
import { github } from "../../lib/actions.ts";
import { Prose } from "../parts/Prose.tsx";
import {
  GitHubDialog,
  GitHubFeedback,
  GitHubLink,
  GitHubPagination,
  GitHubState,
  formNames,
  formText,
  githubDate,
} from "./GitHubShared.tsx";
import type {
  GitHubRepository,
  GitHubItem,
  GitHubMutation,
} from "../../../../shared/github.ts";

type Action =
  | "new"
  | "edit"
  | "comment"
  | "state"
  | "review"
  | "merge"
  | "ready"
  | "reviewers";

export function GitHubItems({
  repository,
  pull,
  branch,
  currentUser,
}: {
  repository: GitHubRepository;
  pull: boolean;
  branch?: string;
  currentUser: string;
}) {
  const repo = repository.full_name;
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [state, setState] = useState<"open" | "closed" | "all">("open");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<number | null>(null);
  const [tab, setTab] = useState("Conversation");
  const [action, setAction] = useState<Action | null>(null);
  const [feedback, setFeedback] = useState("");
  const list = useGitHub("items", { repo, pull, state, query: search, page });
  const detail = useGitHub(
    "detail",
    selected ? { repo, pull, number: selected } : null,
  );
  const branches = useGitHub(
    "branches",
    action === "new" && pull ? { repo } : null,
  );
  const item = detail.data?.item;
  const canManage = Boolean(repository.permissions?.push);
  const canEdit = canManage || item?.user?.login === currentUser;
  const refresh = () => {
    list.refresh();
    if (selected) detail.refresh();
  };
  const itemState = (entry: GitHubItem) =>
    entry.merged || entry.merged_at || entry.pull_request?.merged_at
      ? "merged"
      : entry.draft
        ? "draft"
        : entry.state;
  const submit = async (data: FormData) => {
    let mutation: GitHubMutation;
    const number = selected ?? 0;
    switch (action) {
      case "new":
        mutation = pull
          ? {
              action: "createPull",
              title: formText(data, "title"),
              body: formText(data, "body"),
              head: formText(data, "head"),
              base: formText(data, "base"),
              draft: data.has("draft"),
            }
          : {
              action: "createIssue",
              title: formText(data, "title"),
              body: formText(data, "body"),
              labels: formNames(data, "labels"),
              assignees: formNames(data, "assignees"),
            };
        break;
      case "edit":
        mutation = {
          action: "editItem",
          number,
          title: formText(data, "title"),
          body: formText(data, "body"),
          labels: formNames(data, "labels"),
          assignees: formNames(data, "assignees"),
        };
        break;
      case "comment":
        mutation = { action: "comment", number, body: formText(data, "body") };
        break;
      case "state":
        mutation = {
          action: "state",
          number,
          pull,
          state: item?.state === "open" ? "closed" : "open",
        };
        break;
      case "review":
        mutation = {
          action: "review",
          number,
          body: formText(data, "body"),
          event: formText(data, "event") as
            | "APPROVE"
            | "REQUEST_CHANGES"
            | "COMMENT",
          sha: item?.head?.sha ?? "",
        };
        break;
      case "merge":
        mutation = {
          action: "merge",
          number,
          method: formText(data, "method") as "squash" | "merge" | "rebase",
          sha: item?.head?.sha ?? "",
        };
        break;
      case "ready":
        mutation = { action: "ready", number };
        break;
      case "reviewers":
        mutation = {
          action: "requestReview",
          number,
          reviewers: formNames(data, "reviewers"),
        };
        break;
      default:
        return;
    }
    const result = await github("mutate", { repo, mutation });
    setFeedback(result.message);
    refresh();
  };
  const titles: Record<Action, string> = {
    new: pull ? "New pull request" : "New issue",
    edit: "Edit details",
    comment: "Add a comment",
    state: item?.state === "open" ? "Close on GitHub" : "Reopen on GitHub",
    review: "Submit a review",
    merge: "Merge pull request",
    ready: "Mark ready for review",
    reviewers: "Request a review",
  };
  return (
    <div className="github-workspace">
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
            aria-label={pull ? "Search pull requests" : "Search issues"}
            placeholder={pull ? "Search pull requests…" : "Search issues…"}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button className="btn" type="submit">
            Search
          </button>
        </form>
        <select
          aria-label="State"
          value={state}
          onChange={(event) => {
            setState(event.target.value as typeof state);
            setPage(1);
          }}
        >
          <option value="open">Open</option>
          <option value="closed">Closed</option>
          <option value="all">All states</option>
        </select>
        <button
          className="icon-btn"
          onClick={refresh}
          title="Refresh"
          aria-label="Refresh items"
          disabled={list.loading}
        >
          <RefreshCw size={16} />
        </button>
        <button
          className="btn"
          data-variant="primary"
          onClick={() => setAction("new")}
          disabled={repository.archived}
        >
          <Plus size={15} />
          {pull ? "New pull request" : "New issue"}
        </button>
      </div>
      {feedback && (
        <div className="github-notice" role="status">
          <Check size={16} />
          {feedback}
        </div>
      )}
      <div className="github-split" data-detail={Boolean(selected)}>
        <div className="github-list scroll">
          <div className="github-list-caption">
            {list.data?.total ?? ""} {pull ? "pull requests" : "issues"}
          </div>
          <GitHubFeedback
            error={list.error}
            loading={list.loading && !list.data}
            empty={
              list.data?.items.length === 0
                ? `No ${state === "all" ? "" : state + " "}${pull ? "pull requests" : "issues"}`
                : undefined
            }
          />
          {list.data?.items.map((entry) => (
            <button
              key={entry.id}
              className="github-item"
              aria-pressed={selected === entry.number}
              onClick={() => {
                setSelected(entry.number);
                setTab("Conversation");
              }}
            >
              <GitHubState state={itemState(entry)} pull={pull} />
              <strong>{entry.title}</strong>
              <span className="github-meta">
                #{entry.number} · {entry.user?.login ?? "Deleted user"} ·{" "}
                {githubDate(entry.updated_at)}
              </span>
              <div className="github-labels">
                {entry.labels.slice(0, 3).map((label) => (
                  <span key={label.name}>{label.name}</span>
                ))}
              </div>
            </button>
          ))}
          {list.data && (
            <GitHubPagination
              page={page}
              more={list.data.more}
              onChange={setPage}
            />
          )}
        </div>
        <ResizeHandle panel="github" inline />
        <div className="github-detail scroll">
          {!selected ? (
            <div className="github-empty">
              <MessageSquare size={30} />
              <h2>Select {pull ? "a pull request" : "an issue"}</h2>
              <p>
                Read the conversation, review changes, and follow its progress
                here.
              </p>
            </div>
          ) : (
            <>
              <button
                className="btn github-detail-back"
                onClick={() => setSelected(null)}
              >
                <ArrowLeft size={15} />
                Back to {pull ? "pull requests" : "issues"}
              </button>
              <GitHubFeedback
                error={detail.error}
                loading={detail.loading && !detail.data}
              />
              {item && (
                <>
                  <header className="github-item-heading">
                    <GitHubState state={itemState(item)} pull={pull} />
                    <span className="github-meta">#{item.number}</span>
                    <GitHubLink href={item.html_url}>Open on GitHub</GitHubLink>
                    <h2>{item.title}</h2>
                    <p>
                      {item.user?.login ?? "Deleted user"} opened this{" "}
                      {githubDate(item.created_at)}
                    </p>
                  </header>
                  {pull && item.head && (
                    <div className="github-branch-line">
                      <GitBranch size={15} />
                      <code>{item.head.label}</code>
                      <span>into</span>
                      <code>{item.base?.ref}</code>
                    </div>
                  )}
                  <div className="github-detail-actions">
                    <button
                      className="btn"
                      onClick={() => setAction("comment")}
                    >
                      Comment
                    </button>
                    <button
                      className="btn"
                      onClick={() => setAction("edit")}
                      disabled={repository.archived || !canEdit}
                    >
                      Edit
                    </button>
                    {pull && item.state === "open" && (
                      <>
                        <button
                          className="btn"
                          onClick={() => setAction("review")}
                          disabled={item.user?.login === currentUser}
                        >
                          Review
                        </button>
                        {canEdit && (
                          <button
                            className="btn"
                            onClick={() => setAction("reviewers")}
                          >
                            Request review
                          </button>
                        )}
                        {canEdit && item.draft && (
                          <button
                            className="btn"
                            onClick={() => setAction("ready")}
                          >
                            Ready for review
                          </button>
                        )}
                        {canManage && !item.draft && (
                          <button
                            className="btn"
                            data-variant="primary"
                            disabled={item.mergeable === false}
                            onClick={() => setAction("merge")}
                          >
                            Merge…
                          </button>
                        )}
                      </>
                    )}
                    {canEdit && !item.merged && !repository.archived && (
                      <button
                        className="btn"
                        data-variant="ghost"
                        onClick={() => setAction("state")}
                      >
                        {item.state === "open" ? "Close" : "Reopen"}
                      </button>
                    )}
                  </div>
                  {pull && item.mergeable === false && (
                    <p className="github-notice">
                      This pull request has conflicts. Resolve them before
                      merging.
                    </p>
                  )}
                  <div
                    className="github-tabs"
                    role="tablist"
                    aria-label={pull ? "Pull request details" : "Issue details"}
                    onKeyDown={(event) => {
                      const buttons = Array.from(
                        event.currentTarget.querySelectorAll<HTMLButtonElement>(
                          "button",
                        ),
                      );
                      const current = buttons.indexOf(
                        document.activeElement as HTMLButtonElement,
                      );
                      if (
                        current < 0 ||
                        !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                          event.key,
                        )
                      )
                        return;
                      event.preventDefault();
                      const next =
                        event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? buttons.length - 1
                            : (current +
                                (event.key === "ArrowRight"
                                  ? 1
                                  : buttons.length - 1)) %
                              buttons.length;
                      buttons[next]?.click();
                      buttons[next]?.focus();
                    }}
                  >
                    {(pull
                      ? ["Conversation", "Files changed", "Checks"]
                      : ["Conversation"]
                    ).map((name) => (
                      <button
                        role="tab"
                        aria-selected={tab === name}
                        tabIndex={tab === name ? 0 : -1}
                        key={name}
                        onClick={() => setTab(name)}
                      >
                        {name}
                        {name === "Files changed" && (
                          <span>{item.changed_files}</span>
                        )}
                        {name === "Checks" && (
                          <span>
                            {(detail.data?.checks.length ?? 0) +
                              (detail.data?.statuses.length ?? 0)}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                  {tab === "Conversation" && (
                    <div className="github-discussion">
                      <Prose
                        text={item.body || "No description provided."}
                        live={false}
                      />
                      {(item.labels.length > 0 ||
                        item.assignees.length > 0) && (
                        <div className="github-item-metadata">
                          <span>
                            Labels:{" "}
                            {item.labels
                              .map((label) => label.name)
                              .join(", ") || "None"}
                          </span>
                          <span>
                            Assignees:{" "}
                            {item.assignees
                              .map((user) => user.login)
                              .join(", ") || "None"}
                          </span>
                        </div>
                      )}
                      {detail.data?.reviews.map((review) => (
                        <article
                          className="github-comment"
                          key={`review-${review.id}`}
                        >
                          <header>
                            <strong>
                              {review.user?.login ?? "Deleted user"}
                            </strong>
                            <GitHubState state={review.state ?? "commented"} />
                            <GitHubLink
                              className="github-meta"
                              href={review.html_url}
                            >
                              Review
                            </GitHubLink>
                          </header>
                          <Prose text={review.body} live={false} />
                        </article>
                      ))}
                      {detail.data?.comments.map((comment) => (
                        <article className="github-comment" key={comment.id}>
                          <header>
                            <strong>
                              {comment.user?.login ?? "Deleted user"}
                            </strong>
                            <span>{githubDate(comment.created_at!)}</span>
                            <GitHubLink
                              className="github-meta"
                              href={comment.html_url}
                            >
                              Comment
                            </GitHubLink>
                          </header>
                          <Prose text={comment.body} live={false} />
                        </article>
                      ))}
                    </div>
                  )}
                  {tab === "Files changed" && (
                    <div className="github-files">
                      {detail.data?.files.map((file) => (
                        <details key={file.filename} open>
                          <summary>
                            <FileCode2 size={16} />
                            <span>{file.filename}</span>
                            <span className="add">+{file.additions}</span>
                            <span className="del">−{file.deletions}</span>
                          </summary>
                          {file.previous_filename && (
                            <p className="github-meta">
                              Renamed from {file.previous_filename}
                            </p>
                          )}
                          {file.patch ? (
                            <pre className="github-patch">
                              {file.patch.split("\n").map((line, index) => (
                                <span
                                  key={index}
                                  data-kind={
                                    line.startsWith("+")
                                      ? "add"
                                      : line.startsWith("-")
                                        ? "del"
                                        : line.startsWith("@@")
                                          ? "hunk"
                                          : "context"
                                  }
                                >
                                  {line}
                                </span>
                              ))}
                            </pre>
                          ) : (
                            <p className="github-meta">
                              GitHub does not provide an inline diff for this
                              file.{" "}
                              <GitHubLink
                                className="github-inline-link"
                                href={file.blob_url}
                              >
                                View file
                              </GitHubLink>
                            </p>
                          )}
                        </details>
                      ))}
                    </div>
                  )}
                  {tab === "Checks" && (
                    <div className="github-checks">
                      {detail.data?.checks.map((check) => (
                        <div key={check.id}>
                          <GitHubState
                            state={check.conclusion ?? check.status}
                          />
                          <strong>{check.name}</strong>
                          <GitHubLink href={check.details_url}>
                            Details
                          </GitHubLink>
                        </div>
                      ))}
                      {detail.data?.statuses.map((check) => (
                        <div key={check.id}>
                          <GitHubState state={check.state} />
                          <strong>{check.context}</strong>
                          <GitHubLink href={check.target_url}>
                            Details
                          </GitHubLink>
                        </div>
                      ))}
                      {!detail.data?.checks.length &&
                        !detail.data?.statuses.length && (
                          <p className="github-meta">
                            No checks reported for this commit.
                          </p>
                        )}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
      {action && (
        <GitHubDialog
          title={titles[action]}
          description={`${repo}${selected && action !== "new" ? ` · #${selected}` : ""}. ${action === "merge" ? "Merge the reviewed commit into the base branch. GitHub branch protections still apply." : action === "new" && pull ? "Both branches must already be pushed to GitHub." : "Changes will be saved to GitHub under your signed-in account."}`}
          submitLabel={
            action === "new"
              ? pull
                ? "Create pull request"
                : "Create issue"
              : titles[action]
          }
          danger={action === "state" && item?.state === "open"}
          onClose={() => setAction(null)}
          onSubmit={submit}
        >
          {(action === "new" || action === "edit") && (
            <label className="git-field">
              Title
              <input
                name="title"
                defaultValue={action === "edit" ? item?.title : ""}
                required
                maxLength={256}
              />
            </label>
          )}
          {action === "new" && pull && (
            <>
              <GitHubFeedback error={branches.error} />
              <div className="github-form-columns">
                <label className="git-field">
                  Head branch
                  <input
                    name="head"
                    list="github-branches"
                    defaultValue={
                      branch && branch !== repository.default_branch
                        ? branch
                        : ""
                    }
                    placeholder="feature/my-change or owner:branch"
                    required
                  />
                </label>
                <label className="git-field">
                  Base branch
                  <input
                    name="base"
                    list="github-branches"
                    defaultValue={repository.default_branch}
                    required
                  />
                </label>
              </div>
              <datalist id="github-branches">
                {branches.data?.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              <label className="github-checkbox">
                <input type="checkbox" name="draft" defaultChecked />
                Create as a draft
              </label>
            </>
          )}
          {action === "review" && (
            <label className="git-field">
              Review decision
              <select name="event">
                <option value="COMMENT">Comment</option>
                <option value="APPROVE">Approve</option>
                <option value="REQUEST_CHANGES">Request changes</option>
              </select>
            </label>
          )}
          {["new", "edit", "comment", "review"].includes(action) && (
            <label className="git-field">
              {action === "comment" || action === "review"
                ? "Comment"
                : "Description"}
              <textarea
                name="body"
                rows={6}
                defaultValue={action === "edit" ? (item?.body ?? "") : ""}
                required={action === "comment"}
                placeholder="Markdown supported"
              />
            </label>
          )}
          {(action === "edit" || (action === "new" && !pull)) && (
            <div className="github-form-columns">
              <label className="git-field">
                Labels
                <input
                  name="labels"
                  defaultValue={
                    action === "edit"
                      ? item?.labels.map((label) => label.name).join(", ")
                      : ""
                  }
                  placeholder="bug, documentation"
                />
              </label>
              <label className="git-field">
                Assignees
                <input
                  name="assignees"
                  defaultValue={
                    action === "edit"
                      ? item?.assignees.map((user) => user.login).join(", ")
                      : ""
                  }
                  placeholder="usernames, separated by commas"
                />
              </label>
            </div>
          )}
          {action === "reviewers" && (
            <label className="git-field">
              Reviewers
              <input
                name="reviewers"
                required
                placeholder="usernames, separated by commas"
              />
            </label>
          )}
          {action === "merge" && (
            <label className="git-field">
              Merge method
              <select
                name="method"
                defaultValue={
                  repository.allow_squash_merge
                    ? "squash"
                    : repository.allow_merge_commit
                      ? "merge"
                      : "rebase"
                }
              >
                {repository.allow_squash_merge && (
                  <option value="squash">Squash and merge</option>
                )}
                {repository.allow_merge_commit && (
                  <option value="merge">Create a merge commit</option>
                )}
                {repository.allow_rebase_merge && (
                  <option value="rebase">Rebase and merge</option>
                )}
              </select>
              <small>
                Commit {item?.head?.sha.slice(0, 12)} into {item?.base?.ref}
              </small>
            </label>
          )}
        </GitHubDialog>
      )}
    </div>
  );
}
