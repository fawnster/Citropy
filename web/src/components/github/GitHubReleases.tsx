import { useState } from "react";
import { Download, Plus, RefreshCw, Tag } from "lucide-react";
import { useGitHub } from "../../lib/use-github.ts";
import { github } from "../../lib/actions.ts";
import { Prose } from "../parts/Prose.tsx";
import {
  GitHubDialog,
  GitHubFeedback,
  GitHubLink,
  GitHubPagination,
  formText,
  githubDate,
} from "./GitHubShared.tsx";
import type { GitHubRepository } from "../../../../shared/github.ts";

export function GitHubReleases({
  repository,
}: {
  repository: GitHubRepository;
}) {
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState("");
  const releases = useGitHub("releases", { repo: repository.full_name, page });
  return (
    <div className="github-workspace scroll">
      <div className="github-toolbar">
        <h2>Releases</h2>
        <button
          className="icon-btn"
          aria-label="Refresh releases"
          disabled={releases.loading}
          onClick={releases.refresh}
        >
          <RefreshCw size={16} />
        </button>
        <button
          className="btn"
          data-variant="primary"
          disabled={!repository.permissions?.push || repository.archived}
          onClick={() => setCreating(true)}
        >
          <Plus size={15} />
          New release
        </button>
      </div>
      {message && (
        <p className="github-notice" role="status">
          {message}
        </p>
      )}
      <GitHubFeedback
        error={releases.error}
        loading={releases.loading && !releases.data}
        empty={
          releases.data?.items.length === 0 ? "No releases yet" : undefined
        }
      />
      <div className="github-releases">
        {releases.data?.items.map((release) => (
          <article key={release.id}>
            <header>
              <Tag size={19} />
              <h2>{release.name || release.tag_name}</h2>
              {release.draft && <span className="pill">Draft</span>}
              {release.prerelease && <span className="pill">Pre-release</span>}
              <GitHubLink href={release.html_url}>Release</GitHubLink>
            </header>
            <p className="github-meta">
              {release.tag_name}
              {release.published_at && ` · ${githubDate(release.published_at)}`}
            </p>
            <Prose text={release.body || "No release notes."} live={false} />
            {release.assets.length > 0 && (
              <div className="github-release-assets">
                <h3>Downloads</h3>
                {release.assets.map((asset) => (
                  <GitHubLink
                    key={asset.id}
                    href={asset.browser_download_url}
                    className="github-asset"
                  >
                    <Download size={14} />
                    {asset.name}
                    <span>{(asset.size / 1024 / 1024).toFixed(1)} MB</span>
                  </GitHubLink>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
      {releases.data && (
        <GitHubPagination
          page={page}
          more={releases.data.more}
          onChange={setPage}
        />
      )}
      {creating && (
        <GitHubDialog
          title="Create a release"
          description={`Create a release in ${repository.full_name}. Saving a draft keeps it unpublished.`}
          submitLabel="Save release"
          onClose={() => setCreating(false)}
          onSubmit={async (data) => {
            const result = await github("mutate", {
              repo: repository.full_name,
              mutation: {
                action: "createRelease",
                name: formText(data, "name"),
                tag: formText(data, "tag"),
                target: formText(data, "target"),
                body: formText(data, "body"),
                draft: data.has("draft"),
                prerelease: data.has("prerelease"),
              },
            });
            setMessage(result.message);
            releases.refresh();
          }}
        >
          <label className="git-field">
            Release name
            <input name="name" required />
          </label>
          <div className="github-form-columns">
            <label className="git-field">
              Tag
              <input name="tag" placeholder="v1.0.0" required />
            </label>
            <label className="git-field">
              Target branch or commit
              <input
                name="target"
                defaultValue={repository.default_branch}
                required
              />
            </label>
          </div>
          <label className="git-field">
            Release notes
            <textarea name="body" rows={6} />
          </label>
          <label className="github-checkbox">
            <input name="draft" type="checkbox" defaultChecked />
            Save as a draft
          </label>
          <label className="github-checkbox">
            <input name="prerelease" type="checkbox" />
            Mark as a pre-release
          </label>
        </GitHubDialog>
      )}
    </div>
  );
}
