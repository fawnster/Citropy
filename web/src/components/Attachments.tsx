import { serverUrl } from "../lib/environment.ts";
import { AnimatePresence } from "motion/react";
import { useState } from "react";
import { X, Download } from "lucide-react";
import { FileIcon } from "./FileIcon.tsx";
import { Modal } from "./Modal.tsx";
import { FilePreview } from "./FilePreview.tsx";
import { ImageViewer } from "./ImageViewer.tsx";
import { assetQuery } from "../lib/api.ts";
import type { Attachment } from "../../../shared/protocol.ts";
import { useI18n } from "../lib/i18n.ts";

export function Attachments({
  files,
  projectId,
  threadId,
  onRemove,
}: {
  files: Attachment[];
  projectId: string;
  threadId: string;
  onRemove?: (id: string) => void;
}) {
  const t = useI18n();
  const [preview, setPreview] = useState<Attachment>();
  return (
    <>
      <div className="attachments">
        {files.map((file) => (
          <div className="attachment" data-image={file.mime?.startsWith("image/") || undefined} key={file.id ?? file.path}>
            <button
              type="button"
              className="attachment-open"
              onClick={() => setPreview(file)}
              aria-label={`${t("Preview")} ${file.label}`}
              title={`${t("Preview")} ${file.label}`}
            >
              {file.mime?.startsWith("image/") ? (
                <img
                  alt={file.label}
                  loading="lazy"
                  decoding="async"
                  src={serverUrl(`/api/assets?${assetQuery(projectId, file.path, threadId, file.id)}`)}
                />
              ) : (
                <FileIcon path={file.label} mime={file.mime} size={22} className="attachment-file-icon" />
              )}
              {!file.mime?.startsWith("image/") && <span>
                <strong className="truncate">{file.label}</strong>
                <small>
                  {file.size !== undefined
                    ? file.size > 1024 * 1024
                      ? `${(file.size / 1024 / 1024).toFixed(1)} MB`
                      : `${Math.max(1, Math.ceil(file.size / 1024))} KB`
                    : t("File")}
                </small>
              </span>}
            </button>
            {onRemove && (
              <button
                type="button"
                className="icon-btn attachment-remove"
                aria-label={`${t("Remove")} ${file.label}`}
                onClick={() => onRemove(file.id!)}
              >
                <X size={14} />
              </button>
            )}
          </div>
        ))}
      </div>
      <AnimatePresence>{preview && (preview.mime?.startsWith("image/") ? <ImageViewer
        key={preview.id ?? preview.path}
        src={serverUrl(`/api/assets?${assetQuery(projectId, preview.path, threadId, preview.id)}`)}
        name={preview.label}
        onClose={() => setPreview(undefined)}
      /> : (
        <Modal
          title={preview.label}
          icon={<FileIcon path={preview.label} mime={preview.mime} size={21} />}
          className="file-dialog"
          onClose={() => setPreview(undefined)}
          footer={
            <>
              <a
                className="btn"
                href={serverUrl(`/api/assets?${assetQuery(projectId, preview.path, threadId, preview.id)}&download=1`)}
                download={preview.label}
              >
                <Download size={15} />
                {t("Download")}
              </a>
              <button
                className="btn"
                type="button"
                data-cancel
                onClick={() => setPreview(undefined)}
              >
                {t("Close")}
              </button>
            </>
          }
        >
          <FilePreview
            projectId={projectId}
            threadId={threadId}
            attachmentId={preview.id}
            path={preview.path}
            onClose={() => setPreview(undefined)}
            hideHeader
          />
        </Modal>
      ))}</AnimatePresence>
    </>
  );
}
