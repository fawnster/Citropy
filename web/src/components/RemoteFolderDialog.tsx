import { useEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { ArrowUp, Folder, FolderOpen, LoaderCircle, Server } from "lucide-react";
import { Modal } from "./Modal.tsx";
import { useI18n } from "../lib/i18n.ts";
import { finishRemoteFolder, useRemoteFolderRequest, type RemoteFolderRequest as Request } from "../lib/remote-folder.ts";

type Listing = { path: string; parent: string | null; folders: { name: string; hidden: boolean }[] };

export function RemoteFolderDialog() {
  const request = useRemoteFolderRequest((state) => state.request);
  return <AnimatePresence>{request && <RemoteFolderBrowser key={`${request.environmentId}:${request.path}`} request={request} />}</AnimatePresence>;
}

function RemoteFolderBrowser({ request }: { request: Request }) {
  const t = useI18n();
  const [listing, setListing] = useState<Listing>();
  const [typed, setTyped] = useState(request.path);
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const latest = useRef(0);
  const finish = (path: string | null) => finishRemoteFolder(request, path);
  const open = async (path: string) => {
    const attempt = ++latest.current;
    setLoading(true);
    setError("");
    try {
      const result = await window.citropyDesktop!.listWorkspaceFolder!(request.environmentId, path);
      if (attempt !== latest.current) return;
      setListing(result);
      setTyped(result.path);
      return result;
    } catch (error) {
      if (attempt === latest.current) setError((error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    } finally {
      if (attempt === latest.current) setLoading(false);
    }
  };
  useEffect(() => {
    void open(request.path);
    return () => { latest.current++; };
  }, [request]);
  const folders = listing?.folders.filter((folder) => hidden || !folder.hidden) ?? [];
  const join = (name: string) => `${listing!.path === "/" ? "" : listing!.path}/${name}`;
  return (
    <Modal
      title={t("Choose a folder on {host}", { host: request.host })}
      icon={<Server size={20} />}
      className="remote-folder-dialog"
      initialFocus=".remote-folder-path input"
      onClose={() => finish(null)}
      onSubmit={async () => {
        if (!typed.trim() || loading) return;
        const selected = typed === listing?.path ? listing : await open(typed);
        if (selected) finish(selected.path);
      }}
      footer={<>
        <button type="button" className="btn" data-cancel onClick={() => finish(null)}>{t("Cancel")}</button>
        <button type="submit" className="btn" data-variant="primary" disabled={!typed.trim() || loading}><FolderOpen size={15} />{t("Open this folder")}</button>
      </>}
    >
      <div className="remote-folder-path feature-inline">
        <button type="button" className="icon-btn" aria-label={t("Parent folder")} title={t("Parent folder")} disabled={!listing?.parent || loading} onClick={() => listing?.parent && void open(listing.parent)}><ArrowUp size={16} /></button>
        <input aria-label={t("Folder path")} value={typed} readOnly={loading} spellCheck={false} autoComplete="off" placeholder="~/projects" onChange={(event) => setTyped(event.target.value)} />
        <label><input type="checkbox" checked={hidden} onChange={(event) => setHidden(event.target.checked)} />{t("Hidden")}</label>
      </div>
      <div className="remote-folder-list" role="list" aria-busy={loading} aria-label={t("Folders")}>
        {loading && !listing ? <div className="remote-folder-empty"><LoaderCircle size={18} className="spin" />{t("Loading…")}</div>
          : folders.length === 0 ? <div className="remote-folder-empty">{t("No folders here")}</div>
            : folders.map((folder) => <button type="button" role="listitem" key={folder.name} className="remote-folder-row" data-hidden={folder.hidden || undefined} disabled={loading} onClick={() => void open(join(folder.name))}><Folder size={16} /><span className="truncate">{folder.name}</span></button>)}
      </div>
      {error && <p className="dialog-error" role="alert">{error}</p>}
    </Modal>
  );
}
