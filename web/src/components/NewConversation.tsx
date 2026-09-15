import { useEffect, useState } from "react";
import { useI18n } from "../lib/i18n.ts";
import { Folder, GitBranch, GitFork, LoaderCircle } from "lucide-react";
import { Modal } from "./Modal.tsx";
import { ProviderIcon } from "./ProviderIcon.tsx";
import { api } from "../lib/api.ts";
import { loadThread, refreshGit, rememberThreadSettings } from "../lib/actions.ts";
import { selectThread, useApp } from "../lib/store.ts";
import { selectedModel } from "../../../shared/model-options.ts";
import { resolveProjectSettings } from "../../../shared/project-settings.ts";
import type { WorkspaceOptions } from "../../../shared/features.ts";
import type { ProviderId, ThreadMeta, WorkspaceChoice } from "../../../shared/protocol.ts";

export function NewConversation() {
  const t = useI18n();
  const initialProvider = useApp((state) => state.newThreadProvider);
  const [providerId, setProviderId] = useState(initialProvider);
  const providers = useApp((state) => state.providers);
  const defaults = useApp((state) => state.threadDefaults);
  const projectDefaults = useApp((state) => state.projectDefaults);
  const connected = useApp((state) => state.connected);
  const project = useApp((state) =>
    state.projects.find((entry) => entry.id === state.activeProjectId),
  );
  const provider = providers.find((entry) => entry.id === providerId);
  const preferences = resolveProjectSettings(projectDefaults, project?.settings);
  const preferred = preferences.provider === providerId ? preferences : defaults?.provider === providerId ? defaults : undefined;
  const [options, setOptions] = useState<WorkspaceOptions>();
  const [kind, setKind] = useState<WorkspaceChoice["kind"]>(
    preferences.workspace ?? "current",
  );
  const [path, setPath] = useState("");
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("HEAD");
  const [model, setModel] = useState(preferred?.model ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!project) return;
    const controller = new AbortController();
    api<WorkspaceOptions>(`workspaces?projectId=${project.id}`, {
      signal: controller.signal,
    })
      .then(setOptions)
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [project?.id]);
  if (!project || !provider) return null;
  const currentModel = selectedModel(provider.models, model) ?? selectedModel(provider.models);
  const close = () => useApp.setState({ newThreadProvider: null });
  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const thread = await api<ThreadMeta>("threads", {
        method: "POST",
        body: JSON.stringify({
          projectId: project.id,
          provider: provider.id,
          model: currentModel?.id,
          effort: currentModel?.id === selectedModel(provider.models, preferred?.model)?.id ? preferred?.effort : undefined,
          workspace: { kind, path, branch, base },
        }),
      });
      useApp.setState((state) => ({
        threads: { ...state.threads, [thread.id]: thread },
        threadOrder: state.threadOrder.includes(thread.id)
          ? state.threadOrder
          : [thread.id, ...state.threadOrder],
      }));
      selectThread(thread.id);
      rememberThreadSettings(thread);
      loadThread(thread.id);
      refreshGit(project.id);
      close();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("New conversation")}
      description={t("Choose where to work in {project}.", { project: project.name })}
      icon={<GitFork size={22} />}
      busy={busy}
      onClose={close}
      onSubmit={create}
      initialFocus="#conversation-provider"
      footer={
        <>
          <button
            className="btn"
            type="button"
            data-cancel
            onClick={close}
            disabled={busy}
          >
            {t("Cancel")}
          </button>
          <button
            className="btn"
            data-variant="primary"
            disabled={
              busy ||
              !connected ||
              !provider.available ||
              !provider.enabled ||
              !options ||
              (kind === "existing" && !path) ||
              (kind === "new" && !options.hasCommits)
            }
          >
            {busy && <LoaderCircle size={15} className="spin" />}{t("Create conversation")}
          </button>
        </>
      }
    >
      <div className="feature-form-grid">
        <label className="feature-field">
          <span><ProviderIcon provider={provider.id} />{t("Provider")}</span>
          <select
            id="conversation-provider"
            value={provider.id}
            disabled={busy}
            onChange={(event) => {
              const id = event.target.value as ProviderId;
              setProviderId(id);
              setModel(preferences.provider === id ? preferences.model ?? "" : defaults?.provider === id ? defaults.model ?? "" : "");
            }}
          >
            {providers.filter((entry) => entry.available && entry.enabled).map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </select>
        </label>
        <label className="feature-field">
          {t("Model")}
          <select value={currentModel?.id ?? ""} disabled={busy} onChange={(event) => setModel(event.target.value)}>
            {provider.models.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </select>
        </label>
      </div>
      <div
        className="workspace-choices"
        role="radiogroup"
        aria-label={t("Conversation workspace")}
      >
        {[
          {
            id: "current",
            label: t("Current folder"),
            detail: t("Use the project's existing checkout."),
            icon: Folder,
          },
          {
            id: "new",
            label: t("New worktree"),
            detail: t("A separate branch and folder for this conversation."),
            icon: GitFork,
          },
          {
            id: "existing",
            label: t("Existing worktree"),
            detail: t("Continue in a worktree you already have."),
            icon: GitBranch,
          },
        ].map(({ id, label, detail, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={kind === id}
            className="workspace-choice"
            onClick={() => setKind(id as WorkspaceChoice["kind"])}
          >
            <Icon size={20} />
            <span>
              <strong>{label}</strong>
              <small>{detail}</small>
            </span>
            <span className="radio-dot" />
          </button>
        ))}
      </div>
      {kind === "current" && <p className="feature-path">{project.path}</p>}
      {kind === "new" && (
        <>
          {options && !options.hasCommits ? (
            <p className="feature-note">
              {t("Create your first commit in Source control before creating a worktree.")}
            </p>
          ) : (
            <div className="feature-form-grid">
              <label className="feature-field">
                {t("Branch name")}
                <input
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  placeholder={t("Automatically generated")}
                />
              </label>
              <label className="feature-field">
                {t("Start from")}
                <select
                  value={base}
                  onChange={(event) => setBase(event.target.value)}
                >
                  <option value="HEAD">{t("Current commit")}</option>
                  {options?.branches.map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {project.settings?.actions?.some((action) => action.setup) && (
            <p className="feature-note">
              {t("The project's setup actions will run in the new worktree.")}
            </p>
          )}
        </>
      )}
      {kind === "existing" && (
        <label className="feature-field">
          {t("Worktree")}
          <select
            value={path}
            onChange={(event) => setPath(event.target.value)}
          >
            <option value="">{t("Select a worktree")}</option>
            {options?.worktrees
              .filter((entry) => !entry.locked)
              .map((entry) => (
                <option key={entry.path} value={entry.path}>
                  {entry.branch} · {entry.path}
                </option>
              ))}
          </select>
        </label>
      )}
      {error && (
        <p className="feature-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
