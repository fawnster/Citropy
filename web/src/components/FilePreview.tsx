import { useEffect, useState } from "react";
import { X, Download, Code, Eye, File } from "lucide-react";
import { highlight } from "../lib/highlight.ts";
import { langFor } from "../lib/format.ts";
import { useApp } from "../lib/store.ts";
import { api, assetQuery } from "../lib/api.ts";
import { Prose } from "./parts/Prose.tsx";
import type { FilePreviewData } from "../../../shared/features.ts";

export function FilePreview({
  projectId,
  path,
  onClose,
  threadId: selectedThread,
  attachmentId,
  hideHeader = false,
}: {
  projectId: string;
  path: string;
  onClose: () => void;
  threadId?: string;
  attachmentId?: string;
  hideHeader?: boolean;
}) {
  const theme = useApp((state) => state.theme);
  const active = useApp((state) => state.threads[state.activeThreadId ?? ""]);
  const connected = useApp((state) => state.connected);
  const threadId =
    selectedThread ?? (active?.projectId === projectId ? active.id : undefined);
  const [file, setFile] = useState<FilePreviewData>();
  const [html, setHtml] = useState("");
  const [error, setError] = useState("");
  const [source, setSource] = useState(false);
  const query = assetQuery(projectId, path, threadId, attachmentId);
  const url = `/api/assets?${query}`;
  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController();
    setFile(undefined);
    setError("");
    setHtml("");
    setSource(false);
    api<FilePreviewData>(`preview?${query}`, { signal: controller.signal })
      .then(async (data) => {
        if (controller.signal.aborted) return;
        setFile(data);
        if (data.text !== undefined) {
          const rendered = await highlight(data.text, langFor(path), theme);
          if (!controller.signal.aborted) setHtml(rendered);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [query, theme, connected]);
  const renderedDocument =
    file?.mime === "text/html" || file?.mime === "text/markdown";
  return (
    <div className="preview rich-preview">
      {!hideHeader && (
        <div className="preview-head">
          <span className="truncate">{file?.name ?? path}</span>
          <a
            className="icon-btn"
            aria-label="Download file"
            href={`${url}&download=1`}
            download
          >
            <Download size={15} />
          </a>
          <button
            className="icon-btn"
            type="button"
            onClick={onClose}
            aria-label="Close preview"
          >
            <X size={15} />
          </button>
        </div>
      )}
      {file && (
        <div className="preview-toolbar">
          <span>
            {file.mime === "application/octet-stream" && file.text !== undefined
              ? "Source file"
              : file.mime}{" "}
            ·{" "}
            {file.size > 1024 * 1024
              ? `${(file.size / 1024 / 1024).toFixed(1)} MB`
              : `${Math.ceil(file.size / 1024)} KB`}
          </span>
          {renderedDocument && (
            <button
              className="btn"
              type="button"
              onClick={() => setSource((value) => !value)}
            >
              {source ? <Eye size={14} /> : <Code size={14} />}
              {source ? "Preview" : "Source"}
            </button>
          )}
        </div>
      )}
      {error ? (
        <div className="pane-empty" role="alert">
          {error}
        </div>
      ) : !file ? (
        <div className="pane-empty" role="status">
          {connected ? "Loading preview…" : "Reconnect to load this file."}
        </div>
      ) : (
        <>
          {file.mime.startsWith("image/") ? (
            <div className="media-preview scroll">
              <img src={url} alt={file.name} />
            </div>
          ) : file.mime.startsWith("video/") ? (
            <div className="media-preview">
              <video src={url} controls preload="metadata" />
            </div>
          ) : file.mime.startsWith("audio/") ? (
            <div className="media-preview">
              <audio src={url} controls preload="metadata" />
            </div>
          ) : file.mime === "application/pdf" ? (
            <iframe className="document-preview" title={file.name} src={url} />
          ) : file.mime === "text/html" && !source ? (
            <iframe
              className="document-preview html-preview"
              sandbox=""
              referrerPolicy="no-referrer"
              title={file.name}
              srcDoc={file.text ?? ""}
            />
          ) : file.mime === "text/markdown" && !source ? (
            <div className="markdown-preview scroll">
              <Prose text={file.text ?? ""} live={false} />
            </div>
          ) : file.text !== undefined ? (
            html ? (
              <div
                className="preview-body scroll"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            ) : (
              <pre className="preview-body scroll">{file.text}</pre>
            )
          ) : (
            <div className="pane-empty">
              <File size={30} />
              <p>This file can be downloaded to open in another application.</p>
              <a className="btn" href={`${url}&download=1`} download>
                Download {file.name}
              </a>
            </div>
          )}
          {file.truncated && (
            <p className="feature-note">
              Showing the first 512 KB. Download the file to read it in full.
            </p>
          )}
        </>
      )}
    </div>
  );
}
