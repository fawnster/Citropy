import { Working } from "./Working.tsx";
import { useShallow } from "zustand/react/shallow";
import type { ToolPart } from "../../../shared/protocol.ts";
import { useApp } from "../lib/store.ts";
import { useDisclosure } from "../lib/use-disclosure.ts";
import { useI18n } from "../lib/i18n.ts";
import { groupStats, toolLabel } from "../lib/group.ts";
import { AlertTriangle, ChevronRight, ListChecks, shapeIcon } from "./icons.ts";
import { Prose } from "./parts/Prose.tsx";
import { Collapsible } from "./Collapsible.tsx";
import { ImageStrip } from "./parts/ImageStrip.tsx";

export function WorkDetails({ id, ids, messageIds, open, active, previewId, transitionActivity }: { id: string; ids: string[]; messageIds: string[]; open: boolean; active: boolean; previewId?: string; transitionActivity?: (id: string, update: () => void) => void }) {
  const t = useI18n();
  const [, setOpen] = useDisclosure(id, "activity");
  const tools = useApp(useShallow(state => ids.map(id => state.parts[id]).filter((part): part is ToolPart => part?.kind === "tool")));
  const stats = groupStats(tools);
  const thread = useApp(state => active && !open ? state.threads[state.activeThreadId ?? ""] : undefined);
  const preview = useApp(state => previewId ? state.parts[previewId] : undefined);
  const hasGallery = useApp(state => messageIds.some(id => state.messages[id]?.partIds.some(partId => {
    const part = state.parts[partId];
    return part?.kind === "images" && part.files.length > 0;
  })));
  const latest = active ? tools.findLast(tool => tool.status === "running") ?? tools.at(-1)
    : hasGallery ? undefined : tools.findLast(tool => tool.images?.length || tool.imageFiles?.length);
  const Icon = latest && shapeIcon[latest.shape];
  const action = latest && `${toolLabel(latest.name, latest.status, t)}${latest.shape === "command" ? ` ${t("command")}` : ""}`;
  const detail = latest?.shape === "command" ? latest.detail : latest?.shape === "generic" ? undefined : latest?.headline;
  return (
    <div className="activity-summary" data-active={active || undefined}>
      <Collapsible open={!open && (preview?.kind === "text" || Boolean(latest))} className="activity-update-collapse">
        {preview?.kind === "text" && <div className="activity-update" role="note" aria-label={t("Latest update")}>
          <span className="activity-caption">{t("Latest update")}</span>
          <Prose text={preview.text} live={active && preview.complete !== true} />
        </div>}
        {latest && Icon && <div className="activity-preview" title={`${latest.name}: ${latest.headline}`}>
          <Icon size={13} aria-hidden="true" />
          <span>{action}</span>
          {detail && <span className="truncate">{detail}</span>}
          {(latest.images?.length || latest.imageFiles?.length) ? <ImageStrip key={latest.id} part={latest} compact /> : null}
        </div>}
      </Collapsible>
      <button className="activity-head" type="button" aria-label={t("Work details")} aria-describedby={`activity-count-${id}`} aria-expanded={open} onClick={() => {
        const update = () => setOpen(value => !value);
        if (transitionActivity) transitionActivity(id, update);
        else update();
      }}>
        <ChevronRight size={12} className="group-chevron" />
        {thread ? <Working status={thread.status} compacting={thread.compacting} startedAt={thread.runStartedAt ?? thread.updatedAt} /> : <>
          <ListChecks size={14} className="activity-icon" aria-hidden="true" />
          <span className="group-label">{t("Work details")}</span>
        </>}
        <span id={`activity-count-${id}`} className="activity-count">
          {tools.length > 0 && <span className="reason-count">{tools.length} {t(tools.length === 1 ? "tool" : "tools")}</span>}
          {stats.failed > 0 && <span className="group-failed"><AlertTriangle size={11} aria-hidden="true" />{t(stats.failed === 1 ? "{count} failed tool" : "{count} failed tools", { count: stats.failed })}</span>}
        </span>
      </button>
    </div>
  );
}
