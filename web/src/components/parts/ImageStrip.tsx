import { useMemo, useState } from "react";
import { ImageOff } from "lucide-react";
import { useI18n } from "../../lib/i18n.ts";
import { useApp } from "../../lib/store.ts";
import { serverUrl } from "../../lib/environment.ts";
import { ImageViewer } from "../ImageViewer.tsx";
import type { ToolPart } from "../../../../shared/protocol.ts";

export function ImageStrip({ part, compact = false }: { part: ToolPart; compact?: boolean }) {
  const t = useI18n();
  const projectId = useApp((state) => state.activeProjectId);
  const threadId = useApp((state) => state.activeThreadId);
  const [preview, setPreview] = useState<string | null>(null);
  const [missing, setMissing] = useState<ReadonlySet<string>>(() => new Set());
  const sources = useMemo(() => {
    const collected = new Map<string, { src: string; name: string }>();
    if (part.images?.length) {
      for (const image of part.images)
        collected.set(image.id, {
          src: serverUrl(`/api/tool-images?threadId=${encodeURIComponent(threadId ?? "")}&id=${encodeURIComponent(image.id)}`),
          name: part.headline || part.name,
        });
    } else {
      for (const file of part.imageFiles ?? [])
        collected.set(file.path, {
          src: serverUrl(`/api/assets?${new URLSearchParams({ projectId: projectId ?? "", threadId: threadId ?? "", path: file.path })}`),
          name: file.label,
        });
    }
    return [...collected.entries()].map(([key, value]) => ({ key, ...value }));
  }, [part.images, part.imageFiles, part.headline, part.name, projectId, threadId]);
  if (!sources.length) return null;
  const previewIndex = sources.findIndex((source) => source.key === preview);
  return (
    <>
      <div className="image-strip" data-compact={compact || undefined} data-tool-id={part.id}>
        {sources.map((source) => (
          <button
            key={source.key}
            type="button"
            aria-label={`${t("Preview")} ${source.name}`}
            title={source.name}
            onClick={() => setPreview(source.key)}
          >
            {missing.has(source.src) ? <span className="image-unavailable" role="img" aria-label={t("Image unavailable")}><ImageOff size={20} aria-hidden="true" /><span>{t("Image unavailable")}</span></span> : <img
              src={source.src}
              alt={source.name}
              loading="lazy"
              decoding="async"
              onError={() => setMissing((previous) => new Set(previous).add(source.src))}
            />}
          </button>
        ))}
      </div>
      {previewIndex >= 0 && (
        <ImageViewer
          images={sources}
          index={previewIndex}
          onIndexChange={index => setPreview(sources[index]?.key ?? null)}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}
