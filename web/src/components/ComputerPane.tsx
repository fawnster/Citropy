import { useEffect, useRef, useState } from "react";
import { Monitor, MousePointer2, Pause, Play, RefreshCw, Square, LoaderCircle, Check, AlertCircle, Maximize2 } from "lucide-react";
import { Modal } from "./Modal.tsx";
import { api, reportError } from "../lib/api.ts";
import { useApp } from "../lib/store.ts";
import type { ComputerCapabilities, ComputerFrame, ComputerAction } from "../../../shared/computer.ts";

export function ComputerPane({ active }: { active: boolean }) {
  const state = useApp((value) => value.computer);
  const threadId = useApp((value) => value.activeThreadId);
  const owner = useApp((value) => value.threads[state.threadId ?? ""]);
  const connected = useApp((value) => value.connected);
  const [capabilities, setCapabilities] = useState<ComputerCapabilities>();
  const [frame, setFrame] = useState<ComputerFrame>();
  const [display, setDisplay] = useState("");
  const [live, setLive] = useState(true);
  const [interactive, setInteractive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const image = useRef<HTMLImageElement>(null);
  const acting = useRef(false);
  const pointer = useRef<{ x: number; y: number; at: number } | undefined>(undefined);
  const running = ["active", "paused"].includes(state.status);
  const screenId = state.displays.some((item) => item.id === display) ? display : state.displays[0]?.id;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    api<{ capabilities: ComputerCapabilities }>("computer", { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setCapabilities(result.capabilities);
    }).catch((error) => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [active, connected]);
  useEffect(() => {
    setFrame(undefined);
    setInteractive(false);
  }, [state.threadId, state.startedAt, screenId]);
  useEffect(() => {
    if (!active || !running || !screenId || !state.threadId || !connected) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let capturing = false;
    const capture = async () => {
      if (capturing || controller.signal.aborted || document.hidden) return;
      capturing = true;
      try {
        const next = await api<ComputerFrame>(`computer/screenshot?${new URLSearchParams({ threadId: state.threadId!, displayId: screenId })}`, { signal: controller.signal });
        if (!controller.signal.aborted) { setFrame(next); setError(""); }
      } catch (error) {
        if (!controller.signal.aborted) setError((error as Error).message);
      } finally {
        capturing = false;
        if (live && !controller.signal.aborted) timer = setTimeout(capture, 1500);
      }
    };
    const visible = () => { clearTimeout(timer); if (!document.hidden) void capture(); };
    void capture();
    document.addEventListener("visibilitychange", visible);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [active, running, screenId, state.threadId, state.status, connected, live, refresh]);
  useEffect(() => {
    if (!active || state.status !== "active") setInteractive(false);
    if (!active || !["active", "paused"].includes(state.status)) setExpanded(false);
  }, [active, state.status]);
  const operation = async (path: string, body?: unknown) => {
    setBusy(true);
    setError("");
    try { await api(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  const act = async (input: ComputerAction) => {
    if (acting.current || !state.threadId || state.status !== "active") return;
    acting.current = true;
    try {
      await operation(`computer/action?threadId=${encodeURIComponent(state.threadId)}`, input);
      setRefresh((value) => value + 1);
    } finally { acting.current = false; }
  };
  const point = (clientX: number, clientY: number) => {
    if (!frame || !image.current) return;
    const bounds = image.current.getBoundingClientRect();
    return { x: Math.max(0, Math.min(frame.width - 1, (clientX - bounds.x) * frame.width / bounds.width)), y: Math.max(0, Math.min(frame.height - 1, (clientY - bounds.y) * frame.height / bounds.height)) };
  };
  const enable = async () => {
    setBusy(true);
    try { await api("computer", { method: "PATCH", body: JSON.stringify({ enabled: true }) }); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  const launch = async () => {
    setBusy(true); setError("");
    try {
      await api("desktop", { method: "POST" });
      const result = await api<{ capabilities: ComputerCapabilities }>("computer");
      setCapabilities(result.capabilities);
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <section className="computer-pane scroll" aria-label="Computer use">
      <header className="computer-heading">
        <Monitor size={21} className="panel-icon-computer" />
        <div><h3>Computer</h3><p>{running ? owner?.title ?? "Shared desktop" : "Native desktop applications"}</p></div>
        {running && <span className="computer-state" data-paused={state.status === "paused"}>{state.status === "paused" ? "Paused" : state.control ? "Control active" : "View only"}</span>}
      </header>
      {!running ? (
        <div className="computer-welcome">
          {state.status === "starting" ? <LoaderCircle size={36} className="spin" /> : <Monitor size={38} className="panel-icon-computer" />}
          <h3>{state.status === "starting" ? "Choose what to share" : "Work across your desktop"}</h3>
          <p>{state.status === "starting" ? "Confirm screen sharing in your desktop's dialog. Citropy will show the shared screen here." : "Let this conversation see a screen and use the mouse and keyboard in your desktop apps."}</p>
          {state.status === "starting" ? <button className="btn" onClick={() => void operation("computer/stop")}>Cancel</button> : !state.enabled ? <button className="btn btn-primary" disabled={busy || !connected} onClick={() => void enable()}>Enable computer use</button> : capabilities?.reason?.includes("Open Citropy desktop") ? <button className="btn btn-primary" disabled={busy || !connected} onClick={() => void launch()}><Monitor size={15} /> Open Citropy desktop</button> : <button className="btn btn-primary" disabled={busy || !connected || !threadId || !capabilities?.available} onClick={() => void operation(`computer/start?threadId=${encodeURIComponent(threadId!)}`)}><Play size={15} /> Share a screen</button>}
          {state.status !== "starting" && <small>{capabilities?.available ? `${capabilities.backend === "wayland-portal" ? "Wayland · Desktop consent" : "X11 · Desktop session"} · One conversation at a time` : capabilities?.reason ?? "Checking desktop support…"}</small>}
        </div>
      ) : (
        <>
          <div className="computer-controls">
            <select aria-label="Shared screen" value={screenId} onChange={(event) => setDisplay(event.target.value)}>{state.displays.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.width} × {item.height}</option>)}</select>
            <button className="icon-btn" title="Refresh screenshot" aria-label="Refresh computer screenshot" onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={16} /></button>
            <button className="icon-btn" data-active={live} title={live ? "Pause preview updates" : "Resume preview updates"} aria-label="Live preview" aria-pressed={live} onClick={() => setLive(!live)}>{live ? <Pause size={15} /> : <Play size={15} />}</button>
            <button className="icon-btn" title={expanded ? "Reduce preview" : "Enlarge preview"} aria-label="Enlarge computer preview" aria-pressed={expanded} onClick={() => { setInteractive(false); setExpanded(!expanded); }}><Maximize2 size={16} /></button>
          </div>
          <div className="computer-preview" data-interactive={interactive} tabIndex={interactive ? 0 : -1} role="group" aria-label={interactive ? "Interactive desktop preview. Escape leaves interaction mode." : "Shared desktop preview"}
            onKeyDown={(event) => {
              if (!interactive) return;
              if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setInteractive(false); }

            }}>
            {frame ? <img ref={image} src={`data:image/jpeg;base64,${frame.image}`} alt={`Shared desktop, ${frame.width} by ${frame.height} pixels`} draggable={false}
              onPointerDown={(event) => {
                if (!interactive || event.button !== 0 || busy) return;
                const pos = point(event.clientX, event.clientY);
                if (pos) { pointer.current = { ...pos, at: Date.now() }; event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.parentElement?.focus(); }
              }}
              onPointerUp={(event) => {
                const from = pointer.current;
                pointer.current = undefined;
                if (!interactive || !from) return;
                const to = point(event.clientX, event.clientY);
                if (!to) return;
                if (Math.hypot(to.x - from.x, to.y - from.y) > 5) void act({ action: "drag", frameId: frame.id, x: from.x, y: from.y, toX: to.x, toY: to.y, durationMs: Math.max(100, Math.min(3000, Date.now() - from.at)) });
                else void act({ action: "click", frameId: frame.id, x: to.x, y: to.y });
              }}
              onPointerCancel={() => { pointer.current = undefined; }}
              onContextMenu={(event) => { if (!interactive) return; event.preventDefault(); const pos = point(event.clientX, event.clientY); if (pos) void act({ action: "click", frameId: frame.id, ...pos, button: "right" }); }} /> : <div className="computer-capturing"><LoaderCircle size={24} className="spin" /><span>Waiting for the screen…</span></div>}
          </div>
          <div className="computer-preview-caption"><span>{frame ? `${frame.width} × ${frame.height} preview` : "Screen sharing"}</span><button disabled={!state.control || state.status !== "active" || busy} data-active={interactive} aria-pressed={interactive} onClick={() => setInteractive(!interactive)}><MousePointer2 size={13} /> {interactive ? "Interacting · Esc to leave" : "Interact"}</button></div>
          {interactive && <p className="computer-session-note">Click or drag in the preview. Use your keyboard directly in the focused app.</p>}
          <div className="computer-session-controls">
            <button className="btn" onClick={() => void operation("computer/pause", { paused: state.status !== "paused" })}>{state.status === "paused" ? <Play size={15} /> : <Pause size={15} />}{state.status === "paused" ? "Resume control" : "Pause control"}</button>
            <button className="btn computer-stop" onClick={() => void operation("computer/stop")}><Square size={14} /> Stop sharing</button>
          </div>
          <p className="computer-session-note">{state.shortcut ? "Ctrl+Alt+Escape stops control from any app." : "Use Stop sharing here or in your desktop's sharing indicator."} Automatically stops after five minutes without actions.</p>
        </>
      )}
      {expanded && <Modal title="Computer preview" description={owner?.title} icon={<Monitor size={20} className="panel-icon-computer" />} className="computer-preview-dialog" onClose={() => setExpanded(false)} footer={<><button type="button" className="btn" data-cancel onClick={() => setExpanded(false)}>Close preview</button><button type="button" className="btn computer-stop" onClick={() => void operation("computer/stop")}><Square size={14} /> Stop sharing</button></>}>
        {frame && <img className="computer-large-image" src={`data:image/jpeg;base64,${frame.image}`} alt="Shared desktop at a larger size" />}
      </Modal>}
      {(error || state.error) && <p className="feature-error" role="alert"><AlertCircle size={16} /> {error || state.error}</p>}
      {state.activity.length > 0 && <div className="computer-activity"><h4>Recent activity</h4>{state.activity.slice(0, 20).map((item) => <div className="computer-activity-row" key={item.id}>{item.status === "running" ? <LoaderCircle className="spin" size={14} /> : item.status === "error" ? <AlertCircle size={14} className="text-err" /> : <Check size={14} className="text-ok" />}<span>{item.action}<small>{item.error || (item.actor === "user" ? "You" : "Provider")}</small></span><time>{new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>)}</div>}
    </section>
  );
}

export function ComputerIndicator() {
  const state = useApp((value) => value.computer);
  if (!["starting", "active", "paused"].includes(state.status)) return null;
  return <button className="computer-indicator" title="Stop computer use" aria-label="Stop computer use" onClick={() => void api("computer/stop", { method: "POST" }).catch(reportError)}><Monitor size={15} /><span>{state.status === "starting" ? "Sharing…" : state.status === "paused" ? "Computer paused" : "Computer active"}</span><Square size={11} /></button>;
}
