import type { SshConnection } from "../../../shared/environments.ts";
import { useEffect, useId, useState } from "react";
import { AnimatePresence } from "motion/react";
import { Pencil, Check, LoaderCircle, Monitor, Plus, Server, Trash2 } from "lucide-react";
import { Modal } from "./Modal.tsx";
import { useI18n } from "../lib/i18n.ts";
import { selectEnvironment, useEnvironments } from "../lib/environment.ts";
import { confirmAction } from "../lib/store.ts";

export function NewSshConnection({ onClose, connection }: { onClose: () => void; connection?: SshConnection }) {
  const t = useI18n();
  const id = useId();
  const [name, setName] = useState(connection?.name || "");
  const [target, setTarget] = useState(connection?.target || "");
  const [port, setPort] = useState(connection?.port ? String(connection.port) : "");
  const [node, setNode] = useState(connection?.node || "node");
  const [hosts, setHosts] = useState<string[]>([]);
  const [savedId, setSavedId] = useState<string | undefined>(connection?.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const state = useEnvironments();
  const progress = state.connections.find(entry => entry.id === savedId);
  useEffect(() => { let disposed = false; void window.citropyDesktop?.sshHosts().then(value => { if (!disposed) setHosts(value); }).catch(() => {}); return () => { disposed = true; }; }, []);
  const connect = async () => {
    const desktop = window.citropyDesktop;
    if (!desktop) return;
    setBusy(true);
    setError("");
    try {
      const connectionId = (await desktop.saveEnvironment({ id: savedId, name: name.trim() || target.trim(), target, port: Number(port), node })).id;
      setSavedId(connectionId);
      await selectEnvironment(connectionId);
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  return <Modal title={t("Connect over SSH")} description={t("Work with files, Git, providers, and shells on another machine.")} icon={<Server size={20} />} initialFocus="input" busy={busy} onClose={onClose} onSubmit={() => void connect()} footer={<>
    <button className="btn" type="button" data-cancel onClick={() => { if (busy && savedId) void window.citropyDesktop?.disconnectEnvironment(savedId).catch(error => setError(error.message)); else onClose(); }} disabled={busy && !savedId}>{t(busy ? "Cancel connection" : "Cancel")}</button>
    <button className="btn" data-variant="primary" type="submit" disabled={busy || !target.trim()}>{busy && <LoaderCircle size={14} className="spin" />}{t(savedId ? "Reconnect" : "Connect")}</button>
  </>}>
    <div className="ssh-form feature-field">
      <label htmlFor={`${id}-target`}>{t("SSH host")}</label>
      <input id={`${id}-target`} value={target} onChange={event => setTarget(event.target.value)} list={`${id}-hosts`} placeholder="user@hostname" autoComplete="off" spellCheck={false} required disabled={busy || Boolean(savedId)} />
      <datalist id={`${id}-hosts`}>{hosts.map(host => <option key={host} value={host} />)}</datalist>
      <label htmlFor={`${id}-name`}>{t("Connection name")}</label>
      <input id={`${id}-name`} value={name} onChange={event => setName(event.target.value)} placeholder={t("Optional")} maxLength={80} disabled={busy} />
      <details><summary>{t("SSH options")}</summary><div className="ssh-options">
        <label htmlFor={`${id}-port`}>{t("Port")}</label><input id={`${id}-port`} type="number" min={1} max={65535} placeholder={t("SSH config")} value={port} onChange={event => setPort(event.target.value)} disabled={busy || Boolean(savedId)} />
        <label htmlFor={`${id}-node`}>{t("Remote Node path")}</label><input id={`${id}-node`} value={node} onChange={event => setNode(event.target.value)} disabled={busy} spellCheck={false} />
      </div></details>
      <p className="settings-note">{t("Uses your SSH config, keys, and agent. Connect once in a terminal to trust a new host. Citropy sets up Node.js and its backend under your remote account when needed, without sudo.")}</p>
      <p className="settings-note">{t("Use providers installed and signed in on the remote host. Desktop browser and computer tools are available in Local only.")}</p>
      {busy && <p className="ssh-progress" role="status"><LoaderCircle size={14} className="spin" />{t(progress?.message || "Connecting…")}</p>}
      {error && <p className="ssh-error" role="alert">{error}</p>}
    </div>
  </Modal>;
}

export function EnvironmentSettings() {
  const t = useI18n();
  const state = useEnvironments();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<SshConnection>();
  const [error, setError] = useState("");
  const desktop = window.citropyDesktop;
  const run = async (operation: () => Promise<unknown>) => { setError(""); try { await operation(); } catch (error) { setError((error as Error).message); } };
  return <div className="environment-settings">
    <div className="environment-row"><Monitor size={20} /><div><strong>{t("Local")}</strong><small>{t("Work on this computer")}</small></div>{state.activeId === "local" ? <Check size={16} aria-label={t("Selected")} /> : <button className="btn" onClick={() => void run(() => selectEnvironment("local"))}>{t("Switch to Local")}</button>}</div>
    <div className="environment-heading"><h2>{t("SSH environments")}</h2><button className="btn" onClick={() => setAdding(true)} disabled={!desktop?.saveEnvironment}><Plus size={14} />{t("Add connection")}</button></div>
    {state.connections.map(connection => <div className="environment-row" key={connection.id} data-active={state.activeId === connection.id}>
      <Server size={20} /><div><strong>{connection.name}</strong><small>{connection.target}{connection.port ? `:${connection.port}` : ""}</small><small className={connection.status === "error" ? "ssh-error" : undefined}>{t(connection.message || connection.status)}</small></div>
      <div className="environment-actions">
        {connection.status === "connecting" || connection.status === "connected" ? <button className="btn" onClick={() => void run(() => desktop!.disconnectEnvironment(connection.id))}>{t(connection.status === "connecting" ? "Cancel connection" : "Disconnect")}</button> : <button className="btn" disabled={state.connections.some(entry => entry.status === "connecting")} onClick={() => void run(() => selectEnvironment(connection.id))}>{t(state.activeId === connection.id ? "Reconnect" : "Connect")}</button>}
        <button className="icon-btn" disabled={connection.status === "connecting" || connection.status === "connected"} aria-label={t("Edit {name}", { name: connection.name })} onClick={() => setEditing(connection)}><Pencil size={15} /></button>
        <button className="icon-btn" disabled={state.activeId === connection.id || connection.status === "connecting"} aria-label={t("Remove {name}", { name: connection.name })} onClick={() => void run(async () => { if (await confirmAction({ title: t("Remove SSH connection?"), description: t("This removes the saved connection. Remote files and tasks stay on the host."), label: t("Remove"), danger: true })) await desktop!.removeEnvironment(connection.id); })}><Trash2 size={15} /></button>
      </div>
    </div>)}
    {!state.connections.length && <p className="settings-note">{t("Add an SSH host to work remotely. Each environment keeps its own workspaces and tasks.")}</p>}
    {!desktop?.saveEnvironment && <p className="settings-note">{t("Open Citropy desktop to use SSH environments.")}</p>}
    <p className="settings-note">{t("Disconnecting closes the tunnel. Remote tasks and shells keep running; reconnect to manage them.")}</p>
    {error && <p className="ssh-error" role="alert">{error}</p>}
    <AnimatePresence>{(adding || editing) && <NewSshConnection connection={editing} onClose={() => { setAdding(false); setEditing(undefined); }} />}</AnimatePresence>
  </div>;
}

export function RemoteConnectionBanner() {
  const t = useI18n();
  const state = useEnvironments();
  const [error, setError] = useState("");
  const connection = state.connections.find(entry => entry.status === "connecting") || state.connections.find(entry => entry.id === state.activeId);
  if (!connection || connection.status === "connected") return null;
  const run = async (id: string) => { setError(""); try { await selectEnvironment(id); } catch (error) { setError((error as Error).message); } };
  return <div className="remote-connection-banner" role="status"><Server size={15} /><span>{connection.name}: {t(connection.message || "Disconnected")}{error && <span className="ssh-error"> {error}</span>}</span>
    {connection.status === "connecting" ? <button className="btn" onClick={() => void window.citropyDesktop?.disconnectEnvironment(connection.id)}>{t("Cancel connection")}</button> : <button className="btn" onClick={() => void run(connection.id)}>{t("Reconnect")}</button>}
    <button className="btn" onClick={() => void run("local")}>{t("Switch to Local")}</button>
  </div>;
}
