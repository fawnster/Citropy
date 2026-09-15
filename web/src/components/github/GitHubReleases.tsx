import { AnimatePresence } from "motion/react";
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
import { useI18n } from "../../lib/i18n.ts";

export function GitHubReleases({
  repository,
}: {
  repository: GitHubRepository;
}) {
  const t = useI18n();
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState("");
  const releases = useGitHub("releases", { repo: repository.full_name, page });
  return (
    <div className="github-workspace scroll">
      <div className="github-toolbar">
        <h2>{t("Releases")}</h2>
        <button
          className="icon-btn"
          aria-label={t("Refresh releases")}
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
          {t("New release")}
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
          releases.data?.items.length === 0 ? t("No releases yet") : undefined
        }
      />
      <div className="github-releases">
        {releases.data?.items.map((release) => (
          <article key={release.id}>
            <header>
              <Tag size={19} />
              <h2>{release.name || release.tag_name}</h2>
              {release.draft && <span className="pill">{t("Draft")}</span>}
              {release.prerelease && <span className="pill">{t("Pre-release")}</span>}
              <GitHubLink href={release.html_url}>{t("Release")}</GitHubLink>
            </header>
            <p className="github-meta">
              {release.tag_name}
              {release.published_at && ` · ${githubDate(release.published_at)}`}
            </p>
            <Prose text={release.body || t("No release notes.")} live={false} />
            {release.assets.length > 0 && (
              <div className="github-release-assets">
                <h3>{t("Downloads")}</h3>
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
      <AnimatePresence>{creating && (
        <GitHubDialog
          title={t("Create a release")}
          description={t("Create a release in {repo}. Saving a draft keeps it unpublished.", { repo: repository.full_name })}
          submitLabel={t("Save release")}
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
            {t("Release name")}
            <input name="name" required />
          </label>
          <div className="github-form-columns">
            <label className="git-field">{" "}{t("Tag")}{" "}<input name="tag" placeholder="v1.0.0" required />
            </label>
            <label className="git-field">
              {t("Target branch or commit")}
              <input
                name="target"
                defaultValue={repository.default_branch}
                required
              />
            </label>
          </div>
          <label className="git-field">
            {t("Release notes")}
            <textarea name="body" rows={6} />
          </label>
          <label className="github-checkbox">
            <input name="draft" type="checkbox" defaultChecked />
            {t("Save as a draft")}
          </label>
          <label className="github-checkbox">
            <input name="prerelease" type="checkbox" />
            {t("Mark as a pre-release")}
          </label>
        </GitHubDialog>
      )}</AnimatePresence>
    </div>
  );
}
