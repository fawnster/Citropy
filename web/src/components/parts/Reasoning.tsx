import { Prose } from "./Prose.tsx";
import { Brain, ChevronRight } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "../../lib/store.ts";
import { useDisclosure } from "../../lib/use-disclosure.ts";
import { useI18n } from "../../lib/i18n.ts";
import { Collapsible } from "../Collapsible.tsx";
import type { ReasoningPart } from "../../../../shared/protocol.ts";

interface Props {
  ids: string[];
  live: boolean;
}

export function Reasoning({ ids, live }: Props) {
  const t = useI18n();
  const [open, setOpen] = useDisclosure(ids[0], "reasoning");
  const parts = useApp(useShallow(state => ids.map(id => state.parts[id]).filter((part): part is ReasoningPart => part?.kind === "reasoning" && Boolean(part.text.trim()))));
  if (!parts.length) return null;
  const label = parts.length > 1 ? t("Thoughts ({count})", { count: parts.length }) : t("Thoughts");
  const excerpt = parts.at(-1)!.text.trim().split("\n")[0]!.replace(/^#{1,6}\s+/, "").replace(/[*`]/g, "");
  return <div className="reasoning">
    <button className="reasoning-head" type="button" aria-label={label} title={excerpt} aria-expanded={open} aria-controls={`thoughts-${ids[0]}`} onClick={() => setOpen(!open)}>
      <ChevronRight size={12} className="group-chevron" aria-hidden="true" />
      <Brain size={14} aria-hidden="true" />
      <span className="reasoning-label">{label}</span>
      {!open && <span className="reasoning-excerpt truncate">{excerpt}</span>}
    </button>
    <div id={`thoughts-${ids[0]}`}>
      <Collapsible open={open} className="reasoning-content">
        <div className="reasoning-body">
          {parts.map(part => <Prose key={part.id} partId={part.id} text={part.text} live={live && part.complete !== true} className="reason-text" />)}
        </div>
      </Collapsible>
    </div>
  </div>;
}
