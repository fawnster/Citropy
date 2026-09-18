import { useLayoutEffect, useRef } from "react";
import type { ThreadMeta } from "../../../shared/protocol.ts";
import { scaled, useApp, viewportWidth } from "../lib/store.ts";
import { modelLabel, providerLabels, shortPath, threadActivity } from "../lib/format.ts";
import { currentLocale, useI18n } from "../lib/i18n.ts";
import { ProviderIcon } from "./ProviderIcon.tsx";

export function ThreadPreview({ id, thread, anchor, onClose, onPointerEnter, onPointerLeave }: {
  id: string;
  thread: ThreadMeta;
  anchor: HTMLButtonElement;
  onClose: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const t = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const uiScale = useApp(state => state.uiScale);
  const home = useApp(state => state.home);
  const project = useApp(state => state.projects.find(project => project.id === thread.projectId));
  const provider = useApp(state => state.providers.find(provider => provider.id === thread.provider));
  const activity = threadActivity(thread);
  const status = activity.status;
  const statusLabel = thread.archived ? "Archived" : thread.finished ? "Finished" : activity.label;
  const path = thread.workspacePath ?? project?.path;

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.showPopover();
    const position = () => {
      if (!anchor.isConnected) { onClose(); return; }
      const scale = uiScale / 100;
      const bounds = anchor.getBoundingClientRect();
      const width = Math.min(300, viewportWidth() - 24);
      element.style.width = `${scaled(width)}px`;
      const height = element.offsetHeight / scale;
      const viewportHeight = innerHeight / scale;
      const beside = bounds.right / scale + width + 20 <= viewportWidth();
      const left = beside ? bounds.right / scale + 8 : bounds.left / scale;
      const top = beside ? bounds.top / scale
        : bounds.bottom / scale + height + 20 <= viewportHeight ? bounds.bottom / scale + 8 : bounds.top / scale - height - 8;
      element.style.left = `${scaled(Math.max(12, Math.min(left, viewportWidth() - width - 12)))}px`;
      element.style.top = `${scaled(Math.max(12, Math.min(top, viewportHeight - height - 12)))}px`;
    };
    position();
    const resize = new ResizeObserver(position);
    resize.observe(element);
    resize.observe(anchor);
    const dismiss = (event: Event) => { if (!element.contains(event.target as Node)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", dismiss, true);
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", key);
    return () => {
      resize.disconnect();
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", dismiss, true);
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", key);
      if (element.matches(":popover-open")) element.hidePopover();
    };
  }, [anchor, uiScale, onClose]);

  return <div ref={ref} id={id} className="thread-preview scroll" role="tooltip" popover="manual" onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
    <strong className="thread-preview-title">{thread.title}</strong>
    <div className="thread-preview-model"><ProviderIcon provider={thread.provider} /><span>{modelLabel(provider?.models ?? [], thread.model)}<small>{provider?.label ?? providerLabels[thread.provider]}</small></span></div>
    <dl>
      <dt>{t("Status")}</dt><dd data-status={status}>{t(statusLabel)}</dd>
      <dt>{t("Last activity")}</dt><dd><time dateTime={new Date(thread.updatedAt).toISOString()}>{new Date(thread.updatedAt).toLocaleString(currentLocale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></dd>
      {path && <><dt>{t("Folder")}</dt><dd>{shortPath(path, home)}</dd></>}
      {thread.workspaceBranch && <><dt>{t("Branch")}</dt><dd>{thread.workspaceBranch}</dd></>}
      {Boolean(thread.changedFiles) && <><dt>{t("Changes")}</dt><dd>{thread.changedFiles} {thread.changedFiles === 1 ? t("file") : t("files")}</dd></>}
    </dl>
  </div>;
}
