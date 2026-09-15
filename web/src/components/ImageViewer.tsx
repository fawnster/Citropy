import { useLayoutEffect, useRef, useState } from "react";
import { Download, Minus, Plus } from "lucide-react";
import { Modal } from "./Modal.tsx";
import { useI18n } from "../lib/i18n.ts";

export function ImageViewer({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  const t = useI18n();
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number | null>(null);
  const [error, setError] = useState(false);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setBounds({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const fit = size.width && bounds.width ? Math.min(1, bounds.width / size.width, bounds.height / size.height) : 1;
  const scale = zoom ?? fit;
  const minimum = Math.min(fit, 0.1);
  const ready = size.width > 0 && !error;
  return <Modal
    title={name}
    className="image-viewer"
    onClose={onClose}
    initialFocus=".dialog-heading button"
    actions={<a className="icon-btn" aria-label={t("Download image")} title={t("Download image")} href={`${src}&download=1`} download={name}><Download size={18} /></a>}
    footer={ready && <div className="image-zoom" role="group" aria-label={t("Image zoom")}>
      <button className="icon-btn" type="button" aria-label={t("Zoom out")} disabled={scale <= minimum} onClick={() => setZoom(Math.max(minimum, scale / 1.25))}><Minus size={18} /></button>
      <button className="image-zoom-reset" type="button" title={t("Fit image")} aria-label={t("Fit image")} onClick={() => setZoom(null)}>{Math.round(scale * 100)}%</button>
      <button className="icon-btn" type="button" aria-label={t("Zoom in")} disabled={scale >= 4} onClick={() => setZoom(Math.min(4, scale * 1.25))}><Plus size={18} /></button>
    </div>}
  >
    <div className="image-viewport scroll" ref={viewport} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      {error ? <p className="image-viewer-error" role="alert">{t("Unable to load this image.")}</p> : <div className="image-surface" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
        <img
          src={src}
          alt={name}
          draggable={false}
          style={ready ? { width: size.width * scale, height: size.height * scale } : { visibility: "hidden" }}
          onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          onError={() => setError(true)}
          onDoubleClick={() => setZoom(zoom === null ? 1 : null)}
        />
      </div>}
    </div>
  </Modal>;
}
