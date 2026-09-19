import { useState } from "react";
import { useI18n } from "../../lib/i18n.ts";
import { useApp } from "../../lib/store.ts";
import { serverUrl } from "../../lib/environment.ts";
import { ImageViewer } from "../ImageViewer.tsx";
import type { ImagesPart } from "../../../../shared/protocol.ts";

export function ImageGallery({ part }: { part: ImagesPart }) {
  const t = useI18n();
  const projectId = useApp((state) => state.activeProjectId);
  const threadId = useApp((state) => state.activeThreadId);
  const [preview, setPreview] = useState<number | null>(null);
  if (!projectId || !threadId) return null;
  const url = (path: string) =>
    serverUrl(`/api/assets?${new URLSearchParams({ projectId, path, threadId })}`);
  const current = preview === null ? undefined : part.files[preview];
  return (
    <>
      <div className="image-gallery">
        {part.files.map((file, index) => (
          <button
            key={file.path}
            type="button"
            className="image-gallery-item"
            aria-label={`${t("Preview")} ${file.label}`}
            title={file.label}
            onClick={() => setPreview(index)}
          >
            <img src={url(file.path)} alt={file.label} loading="lazy" decoding="async" />
            <span className="truncate">{file.label}</span>
          </button>
        ))}
      </div>
      {current && (
        <ImageViewer
          key={current.path}
          src={url(current.path)}
          name={current.label}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}
