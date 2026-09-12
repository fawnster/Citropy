import { useState } from "react";
import { Folder, Plus, Trash2, Play, Save } from "lucide-react";
import { api, reportError } from "../lib/api.ts";
import { selectPanel, selectProject, useApp } from "../lib/store.ts";
import { effortLabel } from "../lib/format.ts";
import type {
  Project,
  ProjectSettings as Preferences,
} from "../../../shared/protocol.ts";
import type { PanelTab } from "../../../shared/workbench.ts";
import { useI18n } from "../lib/i18n.ts";

export function ProjectSettings({ onRun }: { onRun: () => void }) {
  const t = useI18n();
  const projects = useApp((state) => state.projects);
  const activeProjectId = useApp((state) => state.activeProjectId);
  const [selected, setSelected] = useState(activeProjectId ?? projects[0]?.id);
  const project = projects.find((entry) => entry.id === selected);
  return (
    <>
      <label className="feature-field project-picker">
        <span>
          <Folder size={16} />
          {t("Project")}
        </span>
        <select
          value={selected ?? ""}
          onChange={(event) => setSelected(event.target.value)}
        >
          {projects.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>
      {project ? (
        <ProjectForm key={project.id} project={project} onRun={onRun} />
      ) : (
        <p className="feature-note">
          {t("Open a workspace to configure its defaults.")}
        </p>
      )}
    </>
  );
}

function ProjectForm({
  project,
  onRun,
}: {
  project: Project;
  onRun: () => void;
}) {
  const t = useI18n();
  const providers = useApp((state) => state.providers);
  const [name, setName] = useState(project.name);
  const [settings, setSettings] = useState<Preferences>(project.settings ?? {});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const provider = providers.find((entry) => entry.id === settings.provider);
  const model = provider?.models.find((entry) => entry.id === settings.model);
  const update = (patch: Partial<Preferences>) => {
    setSettings((previous) => ({ ...previous, ...patch }));
    setSaved(false);
  };
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await api(`projects?projectId=${project.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name, settings }),
      });
      setSaved(true);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const run = async (id: string) => {
    try {
      const panel = await api<PanelTab>(
        `projects/action?projectId=${project.id}`,
        { method: "POST", body: JSON.stringify({ id }) },
      );
      selectProject(project.id);
      selectPanel(panel.id);
      onRun();
    } catch (error) {
      reportError(error);
    }
  };
  return (
    <div className="feature-stack">
      <div className="feature-form-grid">
        <label className="feature-field">
          {t("Project name")}
          <input
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setSaved(false);
            }}
          />
        </label>
        <div className="feature-field">
          <span>{t("Folder")}</span>
          <span className="feature-path">{project.path}</span>
        </div>
      </div>
      <section className="settings-group">
        <h2 className="settings-group-heading">{t("New conversation defaults")}</h2>
        <p className="feature-note">{t("These choices apply to new conversations. Existing conversations keep their settings.")}</p>
        <div className="feature-form-grid">
          <label className="feature-field">
            {t("Provider")}
            <select
              value={settings.provider ?? ""}
              onChange={(event) =>
                update({
                  provider:
                    (event.target.value as Preferences["provider"]) ||
                    undefined,
                  model: undefined,
                  effort: undefined,
                })
              }
            >
              <option value="">{t("Use the last selected provider")}</option>
              {providers.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <label className="feature-field">
            {t("Model")}
            <select
              value={settings.model ?? ""}
              disabled={!provider}
              onChange={(event) =>
                update({
                  model: event.target.value || undefined,
                  effort: undefined,
                })
              }
            >
              <option value="">{t("Use the provider's recommended model")}</option>
              {provider?.models.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <label className="feature-field">
            {t("Reasoning effort")}
            <select
              value={settings.effort ?? ""}
              disabled={!model?.efforts?.length}
              onChange={(event) =>
                update({ effort: event.target.value || undefined })
              }
            >
              <option value="">
                {model?.defaultEffort
                  ? t("{effort} (model preference)", { effort: effortLabel(model.defaultEffort) })
                  : t("Use the model's preference")}
              </option>
              {model?.efforts?.map((entry) => (
                <option key={entry} value={entry}>
                  {effortLabel(entry)}
                </option>
              ))}
            </select>
          </label>
          <label className="feature-field">
            {t("Permissions")}
            <select
              value={settings.permissionMode ?? "manual"}
              onChange={(event) =>
                update({
                  permissionMode: event.target
                    .value as Preferences["permissionMode"],
                })
              }
            >
              <option value="manual">{t("Ask before changes")}</option>
              <option value="acceptEdits">{t("Auto edits")}</option>
              <option value="plan">{t("Plan only")}</option>
              <option value="bypass">{t("Full access")}</option>
            </select>
          </label>
          <label className="feature-field">
            {t("Workspace")}
            <select
              value={settings.workspace ?? "current"}
              onChange={(event) =>
                update({
                  workspace: event.target.value as Preferences["workspace"],
                })
              }
            >
              <option value="current">{t("Current folder")}</option>
              <option value="new">{t("New worktree")}</option>
            </select>
          </label>
        </div>
      </section>
      <section className="settings-group">
        <h2 className="settings-group-heading">{t("Workspace behavior")}</h2>
        <label className="feature-setting-row">
          <span>
            <strong>{t("Pull before starting")}</strong>
            <small>{" "}{t("Fast-forward a clean checkout when it has no local commits.")}{" "}</small>
          </span>
          <input
            className="setting-switch"
            type="checkbox"
            role="switch"
            checked={Boolean(settings.autoPull)}
            onChange={(event) => update({ autoPull: event.target.checked })}
          />
        </label>
        <label className="feature-setting-row">
          <span>
            <strong>{t("Provider browser access")}</strong>
            <small>{" "}{t("Allow conversations in this project to use the shared browser tools.")}{" "}</small>
          </span>
          <input
            className="setting-switch"
            type="checkbox"
            role="switch"
            checked={settings.browserAccess !== false}
            onChange={(event) =>
              update({ browserAccess: event.target.checked })
            }
          />
        </label>
      </section>
      <section className="settings-group">
        <div className="feature-section-heading">
        <h2>{t("Project actions")}</h2>
          <button
            className="btn"
            type="button"
            onClick={() =>
              update({
                actions: [
                  ...(settings.actions ?? []),
                  { id: crypto.randomUUID(), name: "", command: "" },
                ],
              })
            }
          >
            <Plus size={15} />{" "}{t("Add action")}{" "}</button>
        </div>
        <p className="feature-note">{" "}{t("Save commands for your terminal. Setup actions run when you create a worktree.")}{" "}</p>
        {(settings.actions ?? []).map((action, index) => (
          <div className="project-action-editor" key={action.id}>
            <div className="feature-form-grid">
              <label className="feature-field">{" "}{t("Name")}{" "}<input
                  value={action.name}
                  onChange={(event) =>
                    update({
                      actions: settings.actions?.map((entry, i) =>
                        i === index
                          ? { ...entry, name: event.target.value }
                          : entry,
                      ),
                    })
                  }
                  placeholder={t("Run tests")}
                />
              </label>
              <label className="feature-field">{" "}{t("Command")}{" "}<input
                  className="mono"
                  value={action.command}
                  onChange={(event) =>
                    update({
                      actions: settings.actions?.map((entry, i) =>
                        i === index
                          ? { ...entry, command: event.target.value }
                          : entry,
                      ),
                    })
                  }
                  placeholder="npm test"
                />
              </label>
            </div>
            <div className="feature-inline">
              <label>
                <input
                  type="checkbox"
                  checked={Boolean(action.setup)}
                  onChange={(event) =>
                    update({
                      actions: settings.actions?.map((entry, i) =>
                        i === index
                          ? { ...entry, setup: event.target.checked }
                          : entry,
                      ),
                    })
                  }
                />{" "}{t("Run on worktree creation")}{" "}</label>
              <button
                className="icon-btn"
                type="button"
                aria-label={t("Run {name}", { name: action.name || t("action") })}
                disabled={
                  !project.settings?.actions?.some(
                    (entry) => entry.id === action.id,
                  )
                }
                onClick={() => run(action.id)}
              >
                <Play size={15} />
              </button>
              <button
                className="icon-btn"
                type="button"
                aria-label={t("Remove {name}", { name: action.name || t("action") })}
                onClick={() =>
                  update({
                    actions: settings.actions?.filter((_, i) => i !== index),
                  })
                }
              >
                <Trash2 size={15} />
              </button>
            </div>
          </div>
        ))}
      </section>
      {error && (
        <p className="feature-error" role="alert">
          {error}
        </p>
      )}
      <div className="feature-save">
        <span role="status">{saved ? t("Project settings saved") : ""}</span>
        <button
          className="btn"
          data-variant="primary"
          disabled={busy}
          onClick={save}
        >
          <Save size={15} />
          {busy ? t("Saving…") : t("Save settings")}
        </button>
      </div>
    </div>
  );
}
