import { useShallow } from "zustand/react/shallow";
import type { ToolPart } from "../../../shared/protocol.ts";
import { useApp } from "../lib/store.ts";
import { useDisclosure } from "../lib/use-disclosure.ts";
import { useI18n } from "../lib/i18n.ts";
import { groupStats } from "../lib/group.ts";
import { AlertTriangle, ChevronRight, ListChecks } from "./icons.ts";

export function WorkDetails({ id, ids, open }: { id: string; ids: string[]; open: boolean }) {
  const t = useI18n();
  const [, setOpen] = useDisclosure(id, "activity");
  const tools = useApp(useShallow(state => ids.map(id => state.parts[id]).filter((part): part is ToolPart => part?.kind === "tool")));
  const stats = groupStats(tools);
  return (
    <button className="activity-head" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
      <ChevronRight size={12} className="group-chevron" />
      <ListChecks size={14} className="activity-icon" aria-hidden="true" />
      <span className="group-label">{t("Work details")}</span>
      {tools.length > 0 && <span className="reason-count">{tools.length} {t(tools.length === 1 ? "tool" : "tools")}</span>}
      {!open && stats.running && <span className="tool-spin" />}
      {stats.failed > 0 && <span className="group-failed"><AlertTriangle size={11} />{stats.failed}</span>}
    </button>
  );
}
