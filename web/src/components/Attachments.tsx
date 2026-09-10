import { useState } from "react";
import { File, X, Download } from "lucide-react";
import { Modal } from "./Modal.tsx";
import { FilePreview } from "./FilePreview.tsx";
import { assetQuery } from "../lib/api.ts";
import type { Attachment } from "../../../shared/protocol.ts";

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
  const [preview, setPreview] = useState<Attachment>();
  return (
    <>
      <div className="attachments">
        {files.map((file) => (
          <div className="attachment" key={file.id ?? file.path}>
            <button
              type="button"
              className="attachment-open"
              onClick={() => setPreview(file)}
              aria-label={`Preview ${file.label}`}
              title={`Preview ${file.label}`}
            >
              {file.mime?.startsWith("image/") ? (
                <img
                  alt={file.label}
                  src={`/api/assets?${assetQuery(projectId, file.path, threadId, file.id)}`}
                />
              ) : (
                <File size={22} className="attachment-file-icon" />
              )}
              <span>
                <strong className="truncate">{file.label}</strong>
                <small>
                  {file.size !== undefined
                    ? file.size > 1024 * 1024
                      ? `${(file.size / 1024 / 1024).toFixed(1)} MB`
                      : `${Math.max(1, Math.ceil(file.size / 1024))} KB`
                    : "File"}
                </small>
              </span>
            </button>
            {onRemove && (
              <button
                type="button"
                className="icon-btn"
                aria-label={`Remove ${file.label}`}
                onClick={() => onRemove(file.id!)}
              >
                <X size={14} />
              </button>
            )}
          </div>
        ))}
      </div>
      {preview && (
        <Modal
          title={preview.label}
          className="file-dialog"
          onClose={() => setPreview(undefined)}
          footer={
            <>
              <a
                className="btn"
                href={`/api/assets?${assetQuery(projectId, preview.path, threadId, preview.id)}&download=1`}
                download={preview.label}
              >
                <Download size={15} />
                Download
              </a>
              <button
                className="btn"
                type="button"
                data-cancel
                onClick={() => setPreview(undefined)}
              >
                Close
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
      )}
    </>
  );
}
