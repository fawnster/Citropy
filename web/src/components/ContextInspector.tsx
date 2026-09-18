import { Layers } from "lucide-react";
import { useEffect, useState } from "react";
import { Modal } from "./Modal.tsx";
import { api } from "../lib/api.ts";
import { useI18n } from "../lib/i18n.ts";
import type { ContextSource } from "../../../shared/context.ts";
import type { ThreadMeta } from "../../../shared/protocol.ts";

export function ContextInspector({ thread, draft, onClose }: { thread: ThreadMeta; draft: string; onClose: () => void }) {
  const t = useI18n();
  const [data, setData] = useState<{ references: Array<{ path: string; startLine?: number; endLine?: number }>; lastSources: ContextSource[]; instructions: string[]; rebuilt: boolean }>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void api<typeof data>(`threads/context?threadId=${thread.id}`, { method: "POST", body: JSON.stringify({ draft }), signal: controller.signal }).then(setData).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [thread.id, draft]);
  return <Modal title={t("Context sources")} icon={<Layers size={18} />} onClose={onClose} footer={<button type="button" className="btn" data-cancel onClick={onClose}>{t("Close")}</button>}>
    {error && <p className="feature-error" role="alert">{error}</p>}
    {!data && !error && <p role="status">{t("Loading context…")}</p>}
    {data && <div className="feature-stack">
      <section><h3>{t("References in this draft")}</h3>{data.references.length ? data.references.map((reference, index) => <p className="context-source-path" key={index}>{reference.path}{reference.startLine ? `:${reference.startLine}-${reference.endLine}` : ""}</p>) : <p className="feature-note">{t("Type @ to select files or folders. Append #L10-L20 to select lines.")}</p>}</section>
      <section><h3>{t("Context added on the last turn")}</h3>{!data.lastSources.length && <p className="feature-note">{t("No files or folders were added on the last turn.")}</p>}{data.lastSources.map((source, index) => <p className="context-source-path" key={index}>{source.path} · {t(source.kind)} · {source.characters.toLocaleString()} {t("characters")}{source.truncated ? ` · ${t("Excerpt")}` : ""}</p>)}<p className="feature-note">{t("Provider totals include additional context. Character counts here are not exact token counts.")}</p></section>
      <section><h3>{t("Instruction files found")}</h3>{data.instructions.map(path => <p className="context-source-path" key={path}>{path}</p>)}<p className="feature-note">{t("The provider controls when these files are loaded. This list shows the applicable locations found on disk.")}</p></section>
      {data.rebuilt && <p className="feature-note">{t("This conversation continues from visible history in a new provider session. Hidden provider state is not copied.")}</p>}
    </div>}
  </Modal>;
}
