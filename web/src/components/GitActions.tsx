import { isRemote, environmentName } from "../lib/environment.ts";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useReducedMotion } from "../lib/use-reduced-motion.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import type { AssistanceSettings, WritingModel } from "../../../shared/assistance.ts";
import { GitCommitHorizontal, GitBranch, FileDiff, ArrowUpFromLine, LoaderCircle, CircleAlert, RefreshCw, ChevronRight, X } from "lucide-react";
import { selectThread, useApp, viewportWidth } from "../lib/store.ts";
import { api } from "../lib/api.ts";
import { useI18n } from "../lib/i18n.ts";
import { send } from "../lib/socket.ts";
import { openWorkbenchPanel } from "../lib/actions.ts";
import { gitActionBusy, type GitActionState } from "../../../shared/assistance.ts";
import type { ThreadMeta } from "../../../shared/protocol.ts";

export function GitActions({ thread }: { thread: ThreadMeta }) {
  const t = useI18n();
  const reducedMotion = useReducedMotion();
  const project = useApp((state) => state.projects.find((project) => project.id === thread.projectId));
  const view = useApp(state => state.activeView);
  const [panelView, setPanelView] = useState("chat");
  const connected = useApp((state) => state.connected);
  const status = useApp((state) => state.git[thread.id] ?? state.git[thread.projectId]);
  const selection = useApp((state) => state.assistance.commitModel);
  const savedOpen = useApp((state) => state.gitPanelOpen);
  const open = savedOpen && (view === "chat" || panelView === view);
  const uiScale = useApp((state) => state.uiScale);
  const [pending, setPending] = useState<GitActionState["action"] | null>(null);
  const [error, setError] = useState("");
  const [savingModel, setSavingModel] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const id = useId();
  const state = thread.gitAction;
  const busy = Boolean(pending) || gitActionBusy(state);
  const blocked = !connected || thread.running || thread.status === "awaiting" || busy || savingModel;
  const scope = status?.files.some((file) => file.staged) ? "staged" : "all";
  const hasChanges = Boolean(status && !status.clean);
  const canPush = Boolean(status && status.upstream !== null && status.ahead > 0 && status.behind === 0);
  const pushHint = status?.upstream === null ? t("Publish this branch before pushing") : status?.behind ? t("Sync this branch before pushing") : t(canPush ? "Push existing commits to the upstream branch" : "No commits to push");
  const staged = status?.files.filter((file) => file.staged).length ?? 0;
  const added = status?.files.reduce((total, file) => total + file.added, 0) ?? 0;
  const removed = status?.files.reduce((total, file) => total + file.removed, 0) ?? 0;
  const changeModel = async (commitModel: WritingModel | null) => {
    setSavingModel(true);
    setError("");
    try {
      const assistance = await api<AssistanceSettings>("providers/assistance", { method: "PATCH", body: JSON.stringify({ commitModel }) });
      useApp.setState((state) => ({ assistance: { ...state.assistance, commitModel: assistance.commitModel } }));
    } catch (error) { setError((error as Error).message); }
    finally { setSavingModel(false); }
  };
  const setOpen = (value: boolean) => {
    setPanelView(view);
    useApp.setState({ gitPanelOpen: value });
    localStorage.setItem("citropy.gitPanel", value ? "1" : "0");
  };
  const hide = () => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };
  const refresh = useCallback(() => {
    if (document.visibilityState === "visible") send({ t: "git.refresh", projectId: thread.projectId, threadId: thread.id });
  }, [thread.projectId, thread.id]);

  useLayoutEffect(() => {
    const element = panel.current;
    if (!open || !element) return;
    element.showPopover();
    const position = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor) return;
      const scale = uiScale / 100;
      const width = Math.min(300, viewportWidth() - 24);
      element.style.width = `${width}px`;
      element.style.left = `${Math.max(12, Math.min(anchor.right / scale - width, viewportWidth() - width - 12))}px`;
      element.style.top = `${anchor.bottom / scale + 12}px`;
      element.style.maxHeight = `${Math.max(0, (innerHeight - anchor.bottom) / scale - 24)}px`;
    };
    position();
    const resize = new ResizeObserver(position);
    if (trigger.current) resize.observe(trigger.current);
    window.addEventListener("resize", position);
    return () => {
      resize.disconnect();
      window.removeEventListener("resize", position);
    };
  }, [open, uiScale, project?.isGit]);

  useEffect(() => {
    if (!open || !connected || !project?.isGit || busy) return;
    refresh();
    const timer = window.setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [open, connected, project?.isGit, busy, refresh]);

  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      hide();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open]);

  const run = async (action: GitActionState["action"]) => {
    setPending(action);
    setError("");
    try {
      await api(`threads/git-action?threadId=${encodeURIComponent(thread.id)}`, { method: "POST", body: JSON.stringify({ action, scope }) });
    } catch (error) { setError((error as Error).message); }
    finally { setPending(null); }
  };
  const activity = pending === "push" || state?.status === "pushing" ? t("Pushing…") : state?.status === "committing" ? t("Committing…") : pending || state?.status === "generating" ? t("Writing commit…") : "";
  const failed = !busy && Boolean(error || state?.status === "error");
  const Icon = busy ? LoaderCircle : failed ? CircleAlert : GitCommitHorizontal;
  if (!project?.isGit) return null;
  return <div className="git-actions">
    <button ref={trigger} type="button" className="icon-btn git-panel-trigger" aria-label={t("Git actions")} aria-haspopup="dialog" aria-expanded={open} aria-controls={id} data-active={open} data-error={failed || undefined} title={activity || t("Git actions")} onClick={() => setOpen(!open)}>
      <Icon size={16} className={busy ? "spin" : undefined} /><span className="git-trigger-label">Git</span>
    </button>
    <AnimatePresence>{open && <motion.section ref={panel} id={id} popover="manual" className="git-panel scroll" role="dialog" aria-label={t("Git actions")}
      initial={{ opacity: 0, y: reducedMotion ? 0 : -5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reducedMotion ? 0 : -5, pointerEvents: "none" }} transition={{ duration: reducedMotion ? 0 : 0.16 }}>
      <header className="git-panel-heading">
        <h2>{t("Git actions")}</h2>
        <button type="button" className="icon-btn" aria-label={t("Refresh Git status")} title={t("Refresh Git status")} disabled={!connected || busy} onClick={refresh}><RefreshCw size={14} /></button>
        <button type="button" className="icon-btn" aria-label={t("Hide Git panel")} title={t("Hide Git panel")} onClick={hide}><X size={15} /></button>
      </header>
      <div className="git-panel-context" title={thread.workspacePath ?? project.path}>
        <GitBranch size={15} /><span className="truncate">{status?.branch || thread.workspaceBranch || project.branch || t("Branch")}</span>
        <small>{isRemote() ? environmentName() : t(thread.workspacePath && thread.workspacePath !== project.path ? "Worktree" : "Local")}</small>
      </div>
      <button type="button" className="git-panel-changes" disabled={!connected || !status} onClick={() => { setOpen(false); selectThread(thread.id); useApp.setState({ activeView: "chat", readingThreadId: null }); openWorkbenchPanel("changes"); }} aria-label={t("Review changes")}>
        <FileDiff size={16} />
        <span className="git-panel-change-copy"><strong>{t("Changes")}</strong><small>{status ? status.clean ? t("Working tree is clean.") : t(status.files.length === 1 ? "1 changed file" : "{count} changed files", { count: status.files.length }) : t("Loading Git status…")}</small></span>
        {(added > 0 || removed > 0) && <span className="git-panel-counts"><span className="added">+{added}</span><span className="removed">-{removed}</span></span>}
        <ChevronRight size={13} />
      </button>
      <div className="git-panel-body">
        {status && <p className="git-panel-sync">{status.upstream === null ? t("No upstream branch") : status.behind > 0 ? t(status.behind === 1 ? "1 commit behind upstream" : "{count} commits behind upstream", { count: status.behind }) : status.ahead > 0 ? t(status.ahead === 1 ? "1 commit to push" : "{count} commits to push", { count: status.ahead }) : t("No commits to push")}</p>}
        {hasChanges && <p className="git-panel-scope" title={t(scope === "staged" ? "Commit staged changes only" : "Commit all changes in this workspace")}><span>{t("Commit scope")}</span><span>{scope === "staged" ? t(staged === 1 ? "1 staged file" : "{count} staged files", { count: staged }) : t("All changes")}</span></p>}
        {busy && <div className="git-panel-progress" role="status"><LoaderCircle size={14} className="spin" />{activity}</div>}
        {failed && <div className="git-panel-error" role="alert"><CircleAlert size={15} /><p>{error || state?.message}</p></div>}
        <div className="git-panel-buttons">
          {hasChanges && <button type="button" className="btn" data-variant="primary" disabled={blocked} onClick={() => void run("commit")}><GitCommitHorizontal size={15} />{t("AI commit")}</button>}
          <button type="button" className="btn" data-variant={!hasChanges ? "primary" : undefined} disabled={blocked || !canPush} title={pushHint} onClick={() => void run("push")}><ArrowUpFromLine size={15} />{t("Push")}</button>
        </div>
        {hasChanges && <button type="button" className="git-panel-combined" disabled={blocked || Boolean(status?.behind) || status?.upstream === null} title={status?.upstream === null || status?.behind ? pushHint : t("Generate a message, commit, then push to the upstream branch")} onClick={() => void run("commitPush")}><ArrowUpFromLine size={13} />{t("AI commit & push")}</button>}
        {(thread.running || thread.status === "awaiting") && <p className="git-panel-note">{t("Available when this conversation finishes.")}</p>}
        {!connected && <p className="git-panel-note">{t("Disconnected from Citropy")}</p>}
        {(status?.upstream === null || Boolean(status?.behind)) && <button type="button" className="git-panel-combined" onClick={() => { setOpen(false); selectThread(thread.id); useApp.setState({ activeView: "git", readingThreadId: null }); }}>{t(status?.upstream === null ? "Open Source control to publish this branch" : "Open Source control to sync this branch")}</button>}
      </div>
      <footer className="git-panel-footer">
        <span>{t("Commit model")}</span>
        <ModelPicker label={t("Commit model")} value={selection} fallback={{ provider: thread.provider, model: thread.model ?? "default" }} allowConversation disabled={!connected || busy || savingModel} onChange={(value) => void changeModel(value)} />
        {!busy && !error && state?.status === "success" && <details className="git-panel-result">
          <summary><ChevronRight size={13} /><span>{t(state.action === "commit" ? "Last commit" : "Last push")}</span>{state.commit && <code>{state.commit.slice(0, 8)}</code>}</summary>
          <p>{state.message || t("Push finished")}</p>
        </details>}
      </footer>
    </motion.section>}</AnimatePresence>
  </div>;
}
