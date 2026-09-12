import { useState } from "react";
import { GitCommitHorizontal, ArrowUpFromLine, LoaderCircle, Check, CircleAlert } from "lucide-react";
import { Menu } from "./Menu.tsx";
import { useApp } from "../lib/store.ts";
import { api } from "../lib/api.ts";
import { useI18n } from "../lib/i18n.ts";
import { gitActionBusy, type GitActionState } from "../../../shared/assistance.ts";
import type { ThreadMeta } from "../../../shared/protocol.ts";

export function GitActions({ thread }: { thread: ThreadMeta }) {
  const t = useI18n();
  const project = useApp((state) => state.projects.find((project) => project.id === thread.projectId));
  const connected = useApp((state) => state.connected);
  const status = useApp((state) => state.git[thread.id] ?? state.git[thread.projectId]);
  const selection = useApp((state) => state.assistance.commitModel);
  const providers = useApp((state) => state.providers);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  if (!project?.isGit) return null;
  const state = thread.gitAction;
  const busy = pending || gitActionBusy(state);
  const blocked = !connected || thread.running || thread.status === "awaiting" || busy;
  const scope = status?.files.some((file) => file.staged) ? "staged" : "all";
  const selectedProvider = providers.find((provider) => provider.id === (selection?.provider ?? thread.provider));
  const model = selectedProvider?.models.find((model) => model.id === (selection?.model ?? thread.model));
  const run = async (action: GitActionState["action"]) => {
    setPending(true);
    setError("");
    try {
      await api(`threads/git-action?threadId=${encodeURIComponent(thread.id)}`, { method: "POST", body: JSON.stringify({ action, scope }) });
    } catch (error) { setError((error as Error).message); }
    finally { setPending(false); }
  };
  const label = error || state?.status === "error" ? t("Git action failed") : pending || state?.status === "generating" ? t("Writing commit…") :
    state?.status === "committing" ? t("Committing…") : state?.status === "pushing" ? t("Pushing…") :
      state?.status === "success" ? t(state.action === "commit" ? "Committed" : "Pushed") : "";
  const failed = Boolean(error || state?.status === "error");
  const Icon = busy ? LoaderCircle : failed ? CircleAlert : state?.status === "success" ? Check : GitCommitHorizontal;
  return <Menu
    align="end"
    width={310}
    header={t("Git actions")}
    items={[
      { id: "commit", label: t("AI commit"), icon: <GitCommitHorizontal size={15} />, hint: t(scope === "staged" ? "Commit staged changes only" : "Commit all changes in this workspace"), disabled: blocked || !status || status.clean, onSelect: () => void run("commit") },
      { id: "commitPush", label: t("AI commit & push"), icon: <ArrowUpFromLine size={15} />, hint: t("Generate a message, commit, then push to the upstream branch"), disabled: blocked || !status || status.clean, onSelect: () => void run("commitPush") },
      { id: "push", label: t("Push"), icon: <ArrowUpFromLine size={15} />, hint: t("Push existing commits to the upstream branch"), disabled: blocked, onSelect: () => void run("push") },
    ]}
    footer={<div className="chat-git-details" data-error={failed || undefined}>
      {label && <strong role="status">{label}</strong>}
      {(error || state?.message) && <p className="chat-git-message">{error || state?.message}</p>}
      {state?.commit && <code>{state.commit.slice(0, 8)}</code>}
      <small>{t("Commit model")}: {model?.label ?? selection?.model ?? thread.model ?? selectedProvider?.label}</small>
      {(thread.running || thread.status === "awaiting") && <small>{t("Available when this conversation finishes.")}</small>}
    </div>}
    trigger={({ toggle, open, id }) => <button type="button" id={id} className="composer-select chat-git-trigger" aria-label={t("Git actions")} aria-haspopup="menu" aria-expanded={open} title={label || t("Git actions")} onClick={toggle} data-error={failed || undefined}>
      <Icon size={16} className={busy ? "spin" : undefined} />
      {label && <span className="truncate" role="status">{label}</span>}
    </button>}
  />;
}
