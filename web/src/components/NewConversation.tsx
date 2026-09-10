import { useEffect, useState } from "react";
import { Folder, GitBranch, GitFork, LoaderCircle } from "lucide-react";
import { Modal } from "./Modal.tsx";
import { ProviderIcon } from "./ProviderIcon.tsx";
import { api } from "../lib/api.ts";
import { loadThread, refreshGit } from "../lib/actions.ts";
import { selectThread, useApp } from "../lib/store.ts";
import type { WorkspaceOptions } from "../../../shared/features.ts";
import type { ThreadMeta, WorkspaceChoice } from "../../../shared/protocol.ts";

export function NewConversation() {
  const providerId = useApp((state) => state.newThreadProvider);
  const project = useApp((state) =>
    state.projects.find((entry) => entry.id === state.activeProjectId),
  );
  const provider = useApp((state) =>
    state.providers.find((entry) => entry.id === providerId),
  );
  const [options, setOptions] = useState<WorkspaceOptions>();
  const [kind, setKind] = useState<WorkspaceChoice["kind"]>(
    project?.settings?.workspace ?? "current",
  );
  const [path, setPath] = useState("");
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("HEAD");
  const [model, setModel] = useState(
    project?.settings?.provider === providerId
      ? (project.settings.model ?? "")
      : "",
  );
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
          model: model || undefined,
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
      title="New conversation"
      description={`Choose where to work in ${project.name}.`}
      icon={<GitFork size={22} />}
      busy={busy}
      onClose={close}
      onSubmit={create}
      initialFocus="select"
      footer={
        <>
          <button
            className="btn"
            type="button"
            data-cancel
            onClick={close}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className="btn"
            data-variant="primary"
            disabled={
              busy ||
              !options ||
              (kind === "existing" && !path) ||
              (kind === "new" && !options.hasCommits)
            }
          >
            {busy && <LoaderCircle size={15} className="spin" />}Create
            conversation
          </button>
        </>
      }
    >
      <label className="feature-field">
        <span>
          <ProviderIcon provider={provider.id} />
          {provider.label}
        </span>
        <select
          value={
            model ||
            provider.models.find((entry) => entry.isDefault)?.id ||
            provider.models[0]?.id ||
            ""
          }
          onChange={(event) => setModel(event.target.value)}
        >
          {provider.models.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
      <div
        className="workspace-choices"
        role="radiogroup"
        aria-label="Conversation workspace"
      >
        {[
          {
            id: "current",
            label: "Current folder",
            detail: "Use the project's existing checkout.",
            icon: Folder,
          },
          {
            id: "new",
            label: "New worktree",
            detail: "A separate branch and folder for this conversation.",
            icon: GitFork,
          },
          {
            id: "existing",
            label: "Existing worktree",
            detail: "Continue in a worktree you already have.",
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
              Create your first commit in Source control before creating a
              worktree.
            </p>
          ) : (
            <div className="feature-form-grid">
              <label className="feature-field">
                Branch name
                <input
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  placeholder="Automatically generated"
                />
              </label>
              <label className="feature-field">
                Start from
                <select
                  value={base}
                  onChange={(event) => setBase(event.target.value)}
                >
                  <option value="HEAD">Current commit</option>
                  {options?.branches.map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {project.settings?.actions?.some((action) => action.setup) && (
            <p className="feature-note">
              The project's setup actions will run in the new worktree.
            </p>
          )}
        </>
      )}
      {kind === "existing" && (
        <label className="feature-field">
          Worktree
          <select
            value={path}
            onChange={(event) => setPath(event.target.value)}
          >
            <option value="">Select a worktree</option>
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
