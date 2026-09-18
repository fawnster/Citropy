import { useMemo, useState } from "react";
import { useI18n } from "../../lib/i18n.ts";
import { useApp } from "../../lib/store.ts";
import { serverUrl } from "../../lib/environment.ts";
import { ImageViewer } from "../ImageViewer.tsx";

export function ImageStrip({ ids }: { ids: string[] }) {
  const t = useI18n();
  const parts = useApp((state) => state.parts);
  const projectId = useApp((state) => state.activeProjectId);
  const threadId = useApp((state) => state.activeThreadId);
  const [preview, setPreview] = useState<number | null>(null);
  const sources = useMemo(() => {
    const collected = new Map<string, { src: string; name: string }>();
    for (const id of ids) {
      const part = parts[id];
      if (part?.kind !== "tool") continue;
      if (part.images?.length) {
        for (const image of part.images)
          collected.set(image.id, {
            src: serverUrl(`/api/tool-images?threadId=${encodeURIComponent(threadId ?? "")}&id=${encodeURIComponent(image.id)}`),
            name: part.headline || part.name,
          });
        continue;
      }
      for (const file of part.imageFiles ?? [])
        collected.set(file.path, {
          src: serverUrl(`/api/assets?${new URLSearchParams({ projectId: projectId ?? "", threadId: threadId ?? "", path: file.path })}`),
          name: file.label,
        });
    }
    return [...collected.entries()].map(([key, value]) => ({ key, ...value }));
  }, [ids, parts, projectId, threadId]);
  if (!sources.length) return null;
  const current = preview === null ? undefined : sources[preview];
  return (
    <>
      <div className="image-strip">
        {sources.map((source, index) => (
          <button
            key={source.key}
            type="button"
            aria-label={`${t("Preview")} ${source.name}`}
            title={source.name}
            onClick={() => setPreview(index)}
          >
            <img src={source.src} alt={source.name} loading="lazy" decoding="async" />
          </button>
        ))}
      </div>
      {current && (
        <ImageViewer
          key={current.key}
          src={current.src}
          name={current.name}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}
