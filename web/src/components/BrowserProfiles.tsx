import { useEffect, useState } from "react";
import {
  Globe,
  Plus,
  Download,
  Trash2,
  RefreshCw,
  Check,
  Cookie,
} from "lucide-react";
import { api } from "../lib/api.ts";
import { confirmAction, useApp } from "../lib/store.ts";
import type {
  BrowserProfile,
  ImportBrowser,
} from "../../../shared/features.ts";
import { useI18n } from "../lib/i18n.ts";

interface Profiles {
  selected: string;
  profiles: BrowserProfile[];
}

export function BrowserProfiles() {
  const t = useI18n();
  const projects = useApp((state) => state.projects);
  const [projectId, setProjectId] = useState(
    useApp.getState().activeProjectId ?? projects[0]?.id ?? "",
  );
  const [data, setData] = useState<Profiles>();
  const [sources, setSources] = useState<ImportBrowser[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [profileId, setProfileId] = useState("workspace");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const query = `?projectId=${projectId}`;
  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    setData(undefined);
    setError("");
    Promise.all([
      api<Profiles>(`browser/profiles${query}`, { signal: controller.signal }),
      api<ImportBrowser[]>(`browser/sources${query}`, {
        signal: controller.signal,
      }),
    ])
      .then(([profiles, available]) => {
        setData(profiles);
        setProfileId(profiles.selected);
        setSources(available);
        setSourceId(available[0]?.id ?? "");
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [projectId, revision]);
  const action = async (path: string, input: object, method = "POST") => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api<
        Profiles & { imported?: number; skipped?: number }
      >(`browser/${path}${query}`, { method, body: JSON.stringify(input) });
      if (result.profiles) {
        setData(result);
        setProfileId(result.selected);
      } else if (result.imported !== undefined) {
        setMessage(
          t("Imported {imported} cookies. {skipped} expired, partitioned, or protected cookies were skipped.", { imported: result.imported, skipped: result.skipped || 0 }),
        );
        setData(await api<Profiles>(`browser/profiles${query}`));
      } else {
        setMessage(t("Browser data cleared."));
        setData(await api<Profiles>(`browser/profiles${query}`));
      }
      setName("");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const clear = async (kind: string) => {
    if (
      await confirmAction({
        title: t("Clear {kind} from this profile?", { kind: t(kind) }),
        description:
          kind === "cookies"
            ? t("Websites in this browser profile will sign out.")
            : t("Cached pages and resources will be downloaded again."),
        label: t("Clear {kind}", { kind: t(kind) }),
        danger: true,
      })
    )
      await action("clear", { profileId, kind });
  };
  return (
    <div className="feature-stack">
      <label className="feature-field">
        {t("Workspace")}
        <select
          disabled={busy}
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <section className="settings-group">
        <div className="feature-section-heading">
          <h2>{t("Browser profiles")}</h2>
          <button
            className="icon-btn"
            type="button"
            disabled={busy}
            aria-label={t("Refresh browser profiles")}
            onClick={() => setRevision((value) => value + 1)}
          >
            <RefreshCw size={16} />
          </button>
        </div>
        <p className="feature-note">
          {t("Keep logins separate. The selected profile is used for new browser tabs; open tabs keep their current profile.")}
        </p>
        {data?.profiles.map((profile) => (
          <div className="profile-row" key={profile.id}>
            <Globe size={21} />
            <span>
              <strong>{profile.id === "workspace" ? t("Workspace") : profile.name}</strong>
              <small>
                {profile.cookies}{" "}{t("cookies ·")}{" "}{profile.activeTabs}{" "}{t("open tabs")}{" "}</small>
            </span>
            <button
              className="btn"
              disabled={busy || data.selected === profile.id}
              onClick={() => action("profiles", { selected: profile.id })}
            >
              {data.selected === profile.id ? (
                <>
                  <Check size={14} />
                  {t("Selected")}
                </>
              ) : (
                t("Use profile")
              )}
            </button>
            {profile.id !== "workspace" && (
              <button
                className="icon-btn"
                disabled={busy || profile.activeTabs > 0}
                title={
                  profile.activeTabs
                    ? t("Close this profile's tabs first")
                    : t("Delete profile")
                }
                aria-label={t("Delete {name}", { name: profile.name })}
                onClick={async () => {
                  if (
                    await confirmAction({
                      title: t("Delete {name}?", { name: profile.name }),
                      description:
                        "Remove this profile and its saved browser data.",
                      label: t("Delete profile"),
                      danger: true,
                    })
                  )
                    await action("profiles", { id: profile.id }, "DELETE");
                }}
              >
                <Trash2 size={15} />
              </button>
            )}
          </div>
        ))}
        <form
          className="feature-inline"
          onSubmit={(event) => {
            event.preventDefault();
            void action("profiles", { name });
          }}
        >
          <input
            aria-label={t("New browser profile name")}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("Profile name")}
            maxLength={60}
          />
          <button className="btn" disabled={busy || !name.trim() || !data}>
            <Plus size={15} />
            {t("Add profile")}
          </button>
        </form>
      </section>
      <section className="settings-group">
        <h2 className="settings-group-heading">{t("Import signed-in sessions")}</h2>
        <p className="feature-note">{" "}{t("Copy cookies from a browser on this computer. Close that browser first. Your system may ask to unlock its keyring. Some sites may require you to sign in again.")}{" "}</p>
        <div className="feature-form-grid">
          <label className="feature-field">{" "}{t("Import from")}{" "}<select
              disabled={busy}
              value={sourceId}
              onChange={(event) => setSourceId(event.target.value)}
            >
              <option value="">
                {sources.length
                  ? t("Select a browser")
                  : t("No supported browser profiles found")}
              </option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
          </label>
          <label className="feature-field">{" "}{t("Citropy profile")}{" "}<select
              disabled={busy}
              value={profileId}
              onChange={(event) => setProfileId(event.target.value)}
            >
              {data?.profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.id === "workspace" ? t("Workspace") : profile.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button
          className="btn"
          data-variant="primary"
          disabled={busy || !sourceId || !data}
          onClick={() => action("import", { profileId, sourceId })}
        >
          <Download size={15} />
          {busy ? t("Working…") : t("Import cookies")}
        </button>
      </section>
      <section className="settings-group">
        <h2 className="settings-group-heading">{t("Profile data")}</h2>
        <p className="feature-note">{" "}{t("Applies to")}{" "}
          {data?.profiles.find((profile) => profile.id === profileId)?.name ??
            "the selected profile"}
          .
        </p>
        <div className="feature-inline">
          <button
            className="btn"
            disabled={busy || !data}
            onClick={() => clear("cookies")}
          >
            <Cookie size={15} />{" "}{t("Clear cookies")}{" "}</button>
          <button
            className="btn"
            disabled={busy || !data}
            onClick={() => clear("cache")}
          >{" "}{t("Clear cache")}{" "}</button>
        </div>
      </section>
      {message && (
        <p className="feature-success" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="feature-error" role="alert">
          {error}
        </p>
      )}
      {!projectId && (
        <p className="feature-note">{" "}{t("Open a workspace to manage browser profiles.")}{" "}</p>
      )}
    </div>
  );
}
