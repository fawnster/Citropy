import { useState } from "react";
import { ImageOff } from "lucide-react";
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
  const [missing, setMissing] = useState<ReadonlySet<string>>(() => new Set());
  if (!projectId || !threadId) return null;
  const url = (path: string) =>
    serverUrl(`/api/assets?${new URLSearchParams({ projectId, path, threadId })}`);
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
            {missing.has(url(file.path)) ? <span className="image-unavailable" role="img" aria-label={t("Image unavailable")}><ImageOff size={20} aria-hidden="true" /><span>{t("Image unavailable")}</span></span> : <img src={url(file.path)} alt={file.label} loading="lazy" decoding="async" onError={() => setMissing((previous) => new Set(previous).add(url(file.path)))} />}
            <span className="truncate">{file.label}</span>
          </button>
        ))}
      </div>
      {preview !== null && part.files[preview] && (
        <ImageViewer
          images={part.files.map(file => ({ src: url(file.path), name: file.label }))}
          index={preview}
          onIndexChange={setPreview}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}
