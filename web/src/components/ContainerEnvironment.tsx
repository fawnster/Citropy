import { useState } from "react";
import { Box, FolderOpen, LoaderCircle } from "lucide-react";
import { Modal } from "./Modal.tsx";
import { selectEnvironment, useEnvironments } from "../lib/environment.ts";
import { send } from "../lib/socket.ts";
import { useI18n } from "../lib/i18n.ts";
import type { SshConnection } from "../../../shared/environments.ts";

export function ContainerEnvironment({ onClose, connection }: { onClose: () => void; connection?: SshConnection }) {
  const t = useI18n();
  const [name, setName] = useState(connection?.name ?? "");
  const [path, setPath] = useState(connection?.target ?? "");
  const [id, setId] = useState(connection?.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const state = useEnvironments();
  const desktop = window.citropyDesktop;
  const connect = async () => {
    if (!desktop) return;
    setBusy(true);
    setError("");
    try {
      const saved = await desktop.saveEnvironment({ id, kind: "container", name: name.trim(), target: path, port: 0, node: "node" });
      setId(saved.id);
      await selectEnvironment(saved.id);
      send({ t: "project.choose", path: "/workspace" });
      onClose();
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  return <Modal title={t("Container workspace")} icon={<Box size={20} />} description={t("Run providers and shells in a Linux container using Docker.")} busy={busy} onClose={onClose} onSubmit={() => void connect()} footer={<>
    <button className="btn" type="button" data-cancel disabled={busy && !id} onClick={() => { if (busy && id) void desktop?.disconnectEnvironment(id).catch(error => setError(error.message)); else onClose(); }}>{t(busy ? "Cancel connection" : "Cancel")}</button>
    <button className="btn" data-variant="primary" type="submit" disabled={busy || !path || !name.trim()}>{busy && <LoaderCircle size={14} className="spin" />}{t(id ? "Reconnect" : "Create and connect")}</button>
  </>}>
    <label className="feature-field">{t("Environment name")}<input required maxLength={80} value={name} disabled={busy} onChange={event => setName(event.target.value)} placeholder={t("Container development")} /></label>
    <label className="feature-field">{t("Mounted folder")}<div className="feature-inline"><input readOnly value={path} placeholder={t("Choose a folder")} /><button className="btn" type="button" disabled={busy || Boolean(id)} onClick={() => void desktop?.chooseWorkspaceFolder("local", path).then(value => { if (typeof value === "string" && value) { setPath(value); if (!name) setName(value.split(/[\\/]/).filter(Boolean).at(-1) ?? "Container"); } }).catch(error => setError(error.message))}><FolderOpen size={15} />{t("Browse")}</button></div></label>
    <p className="settings-note">{t("Includes Node, Git, Python and OpenCode. Changes under /workspace change this folder on your computer. Provider sign-ins and task history are stored separately for this environment.")}</p>
    <p className="settings-note">{t("Docker must be running. The first connection builds the image and can take several minutes. Disconnecting leaves its tasks and shells running.")}</p>
    {busy && <p className="ssh-progress" role="status"><LoaderCircle size={14} className="spin" />{t(state.connections.find(entry => entry.id === id)?.message ?? "Connecting…")}</p>}
    {error && <p className="feature-error" role="alert">{error}</p>}
  </Modal>;
}
