import { useEffect, useId, useState } from "react";
import { FileText, RotateCcw, Save } from "lucide-react";
import { Modal } from "./Modal.tsx";
import { api } from "../lib/api.ts";
import { confirmAction } from "../lib/store.ts";
import type { ProviderInfo } from "../../../shared/protocol.ts";
import type { GlobalInstructions } from "../../../shared/provider-settings.ts";
import { useI18n } from "../lib/i18n.ts";

export function ProviderInstructions({
  provider,
  onClose,
}: {
  provider: ProviderInfo;
  onClose: () => void;
}) {
  const t = useI18n();
  const id = useId();
  const [file, setFile] = useState<GlobalInstructions>();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [revision, setRevision] = useState(0);
  const dirty = Boolean(file && draft !== file.content);
  const path = `providers/instructions?provider=${provider.id}`;

  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError("");
    void api<GlobalInstructions>(path, { signal: controller.signal })
      .then((value) => {
        setFile(value);
        setDraft(value.content);
        setSaved(false);
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [path, revision]);

  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);

  const discard = () =>
    !dirty ||
    confirmAction({
      title: t("Discard your instruction changes?"),
      description:
        t("Your saved file will stay as it is. The unsaved draft will be discarded."),
      label: t("Discard draft"),
      danger: true,
    });
  const save = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError("");
    try {
      const value = await api<GlobalInstructions>(path, {
        method: "PUT",
        body: JSON.stringify({ content: draft, revision: file.revision }),
      });
      setFile(value);
      setDraft(value.content);
      setSaved(true);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("{provider} instructions", { provider: provider.label })}
      description={t("Global guidance for every project using this provider, including its CLI. Changes apply when you next start a conversation.")}
      icon={<FileText size={21} />}
      className="provider-instructions-dialog"
      initialFocus="textarea"
      busy={busy}
      onClose={() =>
        void Promise.resolve(discard()).then((ok) => {
          if (ok) onClose();
        })
      }
      onSubmit={() => void save()}
      footer={
        <>
          <button
            className="btn instruction-reload"
            type="button"
            disabled={busy}
            onClick={() =>
              void Promise.resolve(discard()).then((ok) => {
                if (ok) setRevision((value) => value + 1);
              })
            }
          >
            <RotateCcw size={14} />{" "}{t("Reload file")}{" "}</button>
          <span className="instruction-save-state" role="status">
            {busy
              ? "Working…"
              : dirty
                ? "Unsaved changes"
                : saved
                  ? "Saved"
                  : ""}
          </span>
          <button
            className="btn"
            type="button"
            data-cancel
            disabled={busy}
            onClick={() =>
              void Promise.resolve(discard()).then((ok) => {
                if (ok) onClose();
              })
            }
          >{" "}{t("Close")}{" "}</button>
          <button
            className="btn"
            data-variant="primary"
            type="submit"
            disabled={
              busy ||
              !file ||
              (!dirty && file.exists) ||
              (!file?.exists && !draft.trim())
            }
          >
            <Save size={14} />{" "}{t("Save instructions")}{" "}</button>
        </>
      }
    >
      <label htmlFor={id} className="instruction-file-label">
        <span>{file ? file.path : t("Loading global instructions…")}</span>
        {file && !file.exists && <small>{t("Created when you save")}</small>}
      </label>
      {file?.note && <p className="instruction-note">{file.note}</p>}
      <textarea
        id={id}
        aria-label={t("{provider} global instructions", { provider: provider.label })}
        className="instruction-editor scroll"
        value={draft}
        disabled={!file || busy}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
            placeholder={t("Add your coding conventions, preferred workflows, and other guidance…")}
        onChange={(event) => {
          setDraft(event.target.value);
          setSaved(false);
        }}
      />
      <p className="instruction-note">{" "}{t("Saving keeps the previous file as a .citropy-backup beside the original.")}{" "}</p>
      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
