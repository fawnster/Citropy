import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Copy, ExternalLink, Square, Terminal, X } from "lucide-react";
import type { NotificationTarget, ShellProcess } from "../../../shared/protocol.ts";
import { scaled, selectPanel, useApp, viewportWidth } from "../lib/store.ts";
import { playUiSound } from "../lib/ui-sound.ts";
import { api } from "../lib/api.ts";
import { useI18n } from "../lib/i18n.ts";
import { useReducedMotion } from "../lib/use-reduced-motion.ts";

const active = (shell: ShellProcess) => shell.status === "running" || shell.status === "stopping";

export function RunningShells({ onOpen }: { onOpen: (target: NotificationTarget) => void }) {
  const t = useI18n();
  const count = useApp(state => Object.values(state.shells).filter(active).length);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = () => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };
  return <div className="shells-wrap">
    {(count > 0 || open) && <button ref={trigger} type="button" className="icon-btn shells-trigger" title={t("Running shells")} aria-label={t("Running shells, {count} active", { count })} aria-haspopup="dialog" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <Terminal size={16} /><span>{count}</span>
    </button>}
    <AnimatePresence>{open && <ShellsPanel id={id} trigger={trigger} onClose={close} onOpen={onOpen} />}</AnimatePresence>
  </div>;
}

function ShellsPanel({ id, trigger, onClose, onOpen }: {
  id: string;
  trigger: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onOpen: (target: NotificationTarget) => void;
}) {
  const t = useI18n();
  const reducedMotion = useReducedMotion();
  const shells = useApp(state => state.shells);
  const threads = useApp(state => state.threads);
  const projects = useApp(state => state.projects);
  const panels = useApp(state => state.panels);
  const connected = useApp(state => state.connected);
  const uiScale = useApp(state => state.uiScale);
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<{ id: string; message: string }>();
  const [copied, setCopied] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const output = useRef<HTMLPreElement>(null);
  const followOutput = useRef(true);
  const ordered = useMemo(() => Object.values(shells).sort((a, b) => Number(active(b)) - Number(active(a)) || b.startedAt - a.startedAt), [shells]);
  const [selectedId, setSelectedId] = useState<string | undefined>(() => ordered[0]?.id);
  const running = ordered.filter(active);
  const finished = ordered.filter(shell => !active(shell));
  const selected = (selectedId && shells[selectedId]) || ordered[0];
  const terminal = selected?.panelId && panels.some(panel => panel.id === selected.panelId);
  const owner = (shell: ShellProcess) => shell.threadId && threads[shell.threadId]?.title || projects.find(project => project.id === shell.projectId)?.name || t("Workspace");
  const status = (shell: ShellProcess) => t(shell.status === "running" ? shell.background ? "Background" : "Running" : shell.status === "stopping" ? "Stopping…" : shell.status === "finished" ? "Finished" : shell.status === "failed" ? "Failed" : "Stopped");

  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    element.showPopover();
    const position = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor) return;
      const scale = uiScale / 100;
      const width = Math.min(420, viewportWidth() - 24);
      element.style.width = `${scaled(width)}px`;
      element.style.left = `${scaled(Math.max(12, Math.min(anchor.right / scale - width, viewportWidth() - width - 12)))}px`;
      element.style.top = `${scaled(anchor.bottom / scale + 10)}px`;
      element.style.maxHeight = `${scaled(Math.max(0, (innerHeight - anchor.bottom) / scale - 22))}px`;
    };
    position();
    const resize = new ResizeObserver(position);
    if (trigger.current) resize.observe(trigger.current);
    window.addEventListener("resize", position);
    return () => { resize.disconnect(); window.removeEventListener("resize", position); };
  }, [uiScale, trigger]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", key); };
  }, [onClose, trigger]);

  useEffect(() => { setCopied(false); setError(undefined); }, [selected?.id]);
  useLayoutEffect(() => { followOutput.current = true; }, [selected?.id]);
  useLayoutEffect(() => {
    if (output.current && followOutput.current) output.current.scrollTop = output.current.scrollHeight;
  }, [selected?.output, selected?.id]);

  const stop = async (shell: ShellProcess) => {
    setPending(shell.id);
    setError(undefined);
    try { await api("shells/stop", { method: "POST", body: JSON.stringify({ id: shell.id }) }); }
    catch (error) { setError({ id: shell.id, message: (error as Error).message }); }
    finally { setPending(undefined); }
  };
  const rows = (entries: ShellProcess[]) => entries.map(shell => <button key={shell.id} type="button" className="shell-row" data-selected={selected?.id === shell.id} aria-pressed={selected?.id === shell.id} onClick={() => setSelectedId(shell.id)}>
    <span className="shell-status-dot" data-status={shell.status} />
    <span className="shell-row-copy"><code title={shell.command}>{shell.command || t(shell.panelId ? "Interactive terminal" : "Shell command")}</code><small>{owner(shell)}</small></span>
    <span className="shell-status" data-status={shell.status}>{status(shell)}</span>
  </button>);
  return <motion.section ref={panel} id={id} popover="manual" role="dialog" aria-label={t("Running shells")} className="shells-panel" initial={{ opacity: 0, y: reducedMotion ? 0 : -5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reducedMotion ? 0 : -5, pointerEvents: "none" }} transition={{ duration: reducedMotion ? 0 : 0.16 }}>
    <header><Terminal size={16} /><h2>{t("Running shells")}</h2><span>{t("{count} active", { count: running.length })}</span><button type="button" className="icon-btn" autoFocus aria-label={t("Close running shells")} onClick={onClose}><X size={16} /></button></header>
    <div className="shells-list scroll">
      {rows(running)}
      {finished.length > 0 && <><h3>{t("Recently finished")}</h3>{rows(finished)}</>}
    </div>
    {selected ? <div className="shell-detail">
      <code className="shell-command">{selected.command || t(selected.panelId ? "Interactive terminal" : "Shell command")}</code>
      <div className="shell-directory" title={selected.cwd}>{selected.cwd}</div>
      <div className="shell-actions">
        <button type="button" className="btn btn-sm" onClick={() => {
          onOpen({ view: "chat", projectId: selected.projectId, threadId: selected.threadId });
          if (terminal && selected.panelId) selectPanel(selected.panelId);
          else if (!selected.panelId && selected.threadId) useApp.setState({ searchMessageId: null, searchShellId: selected.id });
          onClose();
        }}><ExternalLink size={13} />{t(terminal ? "Open terminal" : selected.panelId ? "Open task" : "Show command")}</button>
        {active(selected) && <button type="button" className="btn btn-sm" disabled={!connected || Boolean(pending) || selected.status === "stopping"} onClick={() => void stop(selected)}><Square size={12} />{t(selected.status === "stopping" || pending === selected.id ? "Stopping…" : selected.stopMode === "shell" ? "Stop shell" : "Stop task")}</button>}
      </div>
      {active(selected) && selected.stopMode === "task" && <p className="shell-stop-hint">{t("Stopping this shell also stops its AI task.")}</p>}
      {error?.id === selected.id && <p className="shell-error" role="alert">{error.message}</p>}
      <div className="shell-output-heading"><span>{t("Recent output")}</span>{selected.output && <button type="button" className="icon-btn" data-ui-sound="off" aria-label={t(copied ? "Copied" : "Copy output")} onClick={() => { void navigator.clipboard.writeText(selected.output).then(() => { setCopied(true); playUiSound("copy"); }).catch(error => setError({ id: selected.id, message: (error as Error).message })); }}>{copied ? <Check size={13} /> : <Copy size={13} />}</button>}</div>
      {selected.output ? <pre ref={output} className="shell-output scroll" tabIndex={0} aria-label={t("Recent output")} onScroll={event => { const element = event.currentTarget; followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24; }}>{selected.output}</pre> : <p className="shell-output-empty">{t("Output appears when the provider reports it.")}</p>}
    </div> : <p className="shell-output-empty">{t("No shells are running.")}</p>}
  </motion.section>;
}
