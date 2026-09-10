import { useEffect, useState } from "react";
import { CornerDownRight, Network, ChevronUp, ChevronDown } from "lucide-react";
import type { ThreadMeta } from "../../../shared/protocol.ts";
import { loadThread } from "../lib/actions.ts";
import { selectThread } from "../lib/store.ts";
import { groupSubagents } from "../lib/subagents.ts";
import { Check } from "./icons.ts";
import { Collapsible } from "./Collapsible.tsx";
import { ProviderIcon } from "./ProviderIcon.tsx";
import { ThreadPulse } from "./ThreadPulse.tsx";

interface Props {
  parent: ThreadMeta;
  childrenByParent: Map<string, ThreadMeta[]>;
  selectedPath: Set<string>;
  activePaths: Set<string>;
  activeThreadId: string | null;
  onConversation: () => void;
  nested?: boolean;
}

export function ThreadChildren(props: Props) {
  const {
    parent,
    childrenByParent,
    selectedPath,
    activePaths,
    activeThreadId,
    onConversation,
    nested,
  } = props;
  const children = childrenByParent.get(parent.id) ?? [];
  const { current } = groupSubagents(children);
  const visible = children.filter(
    (child) =>
      current.includes(child) ||
      activePaths.has(child.id) ||
      selectedPath.has(child.id),
  );
  const selected = children.some((child) => selectedPath.has(child.id));
  const [open, setOpen] = useState(selected);
  useEffect(() => {
    if (selected) setOpen(true);
  }, [selected, activeThreadId]);
  if (!visible.length) return null;
  return (
    <div
      className="thread-children-disclosure"
      data-open={open}
      data-nested={Boolean(nested)}
      aria-label={`Subagents of ${parent.title}`}
    >
      <div className="thread-children-clip">
        <button
          type="button"
          className="thread-subagents-toggle"
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} subagents of ${parent.title}`}
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          <Network size={13} className="panel-icon-subagents" />
          <span>Subagents</span>
          <span className="thread-completed-count">{visible.length}</span>
        </button>
        <Collapsible open={open} className="thread-children">
          <div className="thread-children-list">
            {visible.map((child) => (
              <div key={child.id}>
                <button
                  type="button"
                  className="thread-child"
                  data-active={child.id === activeThreadId}
                  title={`${child.title} · ${child.status}`}
                  onClick={() => {
                    onConversation();
                    selectThread(child.id);
                    loadThread(child.id);
                  }}
                >
                  <CornerDownRight size={12} />
                  <ProviderIcon provider={child.provider} />
                  <span className="truncate">{child.title}</span>
                  {activePaths.has(child.id) ? (
                    <ThreadPulse status={child.status} />
                  ) : (
                    <Check size={12} className="subagent-complete" />
                  )}
                </button>
                <ThreadChildren {...props} parent={child} nested />
              </div>
            ))}
          </div>
        </Collapsible>
      </div>
    </div>
  );
}
