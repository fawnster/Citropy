import { useI18n } from "../lib/i18n.ts";
import { CircleHelp, Trash2 } from "lucide-react";
import { answerConfirmation, useApp } from "../lib/store.ts";
import { Modal } from "./Modal.tsx";

export function ConfirmationDialog() {
  const t = useI18n();
  const confirmation = useApp((state) => state.confirmation);
  const connected = useApp((state) => state.connected);
  if (!confirmation) return null;
  return (
    <Modal
      title={t(confirmation.title)}
      description={t(confirmation.description)}
      danger={confirmation.danger}
      icon={
        confirmation.danger ? <Trash2 size={21} /> : <CircleHelp size={21} />
      }
      onClose={() => answerConfirmation(false)}
      footer={
        <>
          <button
            type="button"
            className="btn"
            data-cancel
            onClick={() => answerConfirmation(false)}
          >{t("Cancel")}</button>
          <button
            type="button"
            className="btn"
            data-variant={confirmation.danger ? "danger" : "primary"}
            disabled={!connected}
            onClick={() => answerConfirmation(true)}
          >
            {t(confirmation.label)}
          </button>
        </>
      }
    >
      {confirmation.context && (
        <div className="confirmation-context">{confirmation.context}</div>
      )}
      {!connected && (
        <p className="dialog-error" role="alert">{t("Reconnect to Citropy to continue.")}</p>
      )}
    </Modal>
  );
}
