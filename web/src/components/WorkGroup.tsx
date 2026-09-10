import { memo, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Collapsible } from "./Collapsible.tsx";
import { AlertTriangle, ChevronRight, shapeIcon } from "./icons.ts";
import { PartView } from "./PartView.tsx";
import { groupStats, summarize } from "../lib/group.ts";
import { useApp } from "../lib/store.ts";
import type { ToolPart, ToolShape } from "../../../shared/protocol.ts";

export const WorkGroup = memo(function WorkGroup({ ids }: { ids: string[] }) {
  const [open, setOpen] = useState(false);
  const tools = useApp(useShallow((state) =>
    ids.map((id) => state.parts[id]).filter((part): part is ToolPart => part?.kind === "tool"),
  ));

  const stats = useMemo(() => groupStats(tools), [tools]);
  const sentence = useMemo(() => summarize(tools), [tools]);
  const shapes = useMemo(() => {
    const seen: ToolShape[] = [];
    for (const tool of tools) if (!seen.includes(tool.shape)) seen.push(tool.shape);
    return seen.slice(0, 3);
  }, [tools]);

  if (tools.length === 0) return null;

  return (
    <div className="group" data-open={open}>
      <button className="group-head" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ChevronRight size={12} className="group-chevron" />
        <span className="group-icons">
          {shapes.map((shape) => {
            const Icon = shapeIcon[shape];
            return (
              <span className="group-icon" key={shape} data-shape={shape}>
                <Icon size={12} />
              </span>
            );
          })}
        </span>
        <span className="group-label truncate">{sentence}</span>
        {stats.running && <span className="tool-spin" />}
        {stats.failed > 0 && (
          <span className="group-failed">
            <AlertTriangle size={11} />
            {stats.failed}
          </span>
        )}
        {(stats.added > 0 || stats.removed > 0) && (
          <span className="tool-stat">
            {stats.added > 0 && <span className="diff-plus">+{stats.added}</span>}
            {stats.removed > 0 && <span className="diff-minus">-{stats.removed}</span>}
          </span>
        )}
        <span className="group-count">{tools.length}</span>
      </button>

      <Collapsible open={open} className="group-body">
        <div className="group-body-inner">
          {ids.map((id) => (
            <PartView key={id} partId={id} live={false} />
          ))}
        </div>
      </Collapsible>
    </div>
  );
});
