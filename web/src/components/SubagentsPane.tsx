import { useState } from "react";
import { ChevronDown, ChevronUp, History } from "lucide-react";
import { groupSubagents } from "../lib/subagents.ts";
import { Collapsible } from "./Collapsible.tsx";
import { Network, ArrowUpRight, Square } from "lucide-react";
import { loadThread } from "../lib/actions.ts";
import { selectThread, useApp } from "../lib/store.ts";
import { send } from "../lib/socket.ts";
import { ProviderIcon } from "./ProviderIcon.tsx";
import { ThreadPulse } from "./ThreadPulse.tsx";
import { modelLabel } from "../lib/format.ts";

export function SubagentsPane() {
  const threads = useApp((state) => state.threads);
  const activeId = useApp((state) => state.activeThreadId);
  const providers = useApp((state) => state.providers);
  const connected = useApp((state) => state.connected);
  const active = activeId ? threads[activeId] : undefined;
  const parentId = active?.parentThreadId ?? activeId;
  const children = Object.values(threads)
    .filter((thread) => thread.parentThreadId === parentId)
    .sort((a, b) => a.createdAt - b.createdAt);
  const { current, earlier } = groupSubagents(children);
  const [historyOpen, setHistoryOpen] = useState(false);
  const renderChild = (child: (typeof children)[number]) => (
    <div className="subagent-item" key={child.id}>
      <div className="subagent-item-head">
        <ProviderIcon provider={child.provider} />
        <strong>{child.title}</strong>
        <ThreadPulse status={child.status} />
      </div>
      <p>
        {modelLabel(
          providers.find((provider) => provider.id === child.provider)
            ?.models ?? [],
          child.model,
        )}
      </p>
      <div className="subagent-item-footer">
        <span>
          {child.running
            ? "Working"
            : child.status === "error"
              ? "Failed"
              : child.status === "stopped"
                ? "Stopped"
                : "Completed"}
        </span>
        <div>
          {child.running && !child.nativeAgentId && (
            <button
              type="button"
              className="icon-btn"
              disabled={!connected}
              aria-label={`Stop ${child.title}`}
              onClick={() => send({ t: "thread.stop", threadId: child.id })}
            >
              <Square size={13} />
            </button>
          )}
          <button
            className="btn"
            type="button"
            onClick={() => {
              selectThread(child.id);
              loadThread(child.id);
            }}
          >
            View work
            <ArrowUpRight size={13} />
          </button>
        </div>
      </div>
    </div>
  );
  return (
    <div className="subagents-pane scroll">
      <div className="panel-section-heading">
        <Network size={19} className="panel-icon-subagents" />
        <div>
          <h3>Delegated work</h3>
          <p>
            {children.length
              ? `${children.filter((child) => child.running).length} running · ${children.length} subagents`
              : "Subagents for this conversation"}
          </p>
        </div>
      </div>
      {children.length === 0 ? (
        <div className="panel-quiet-empty">
          <p>No subagents yet.</p>
          <span>
            Ask your provider to delegate a task. Its subagents will appear here
            and beneath the chat in your sidebar.
          </span>
        </div>
      ) : (
        current.map(renderChild)
      )}
      {earlier.length > 0 && (
        <div className="subagent-history">
          <button
            type="button"
            className="subagent-history-toggle"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen(!historyOpen)}
          >
            <History size={15} />
            <span>Earlier subagents</span>
            <span>{earlier.length}</span>
            {historyOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          <Collapsible open={historyOpen} className="subagent-history-list">
            {earlier.map(renderChild)}
          </Collapsible>
        </div>
      )}
    </div>
  );
}
