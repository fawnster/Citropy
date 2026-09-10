import { useId, useState } from "react";
import { cost, tokens } from "../lib/format.ts";
import { useApp } from "../lib/store.ts";

export function ContextUsage({ onCompact }: { onCompact?: () => void }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const connected = useApp((state) => state.connected);
  const thread = useApp((state) => state.threads[state.activeThreadId ?? ""]);
  const usage = thread?.usage;
  const contextMax = thread?.contextWindow ?? usage?.contextMax ?? 0;
  const known = Boolean(usage && usage.turns > 0 && contextMax > 0);
  const fill =
    known && usage
      ? Math.max(0, Math.min(usage.contextTokens / contextMax, 1))
      : 0;
  const label = known
    ? `${Math.round(fill * 100)}% context used`
    : "Context usage";

  return (
    <div
      className="context-usage"
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement))
          setOpen(false);
      }}
    >
      <button
        className="context-ring"
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
        data-hot={fill > 0.8}
        data-connected={connected}
      >
        <svg
          width="26"
          height="26"
          viewBox="0 0 32 32"
          fill="none"
          aria-hidden="true"
        >
          <circle
            cx="16"
            cy="16"
            r="12"
            stroke="var(--line-strong)"
            strokeWidth="3"
          />
          <circle
            cx="16"
            cy="16"
            r="12"
            pathLength="100"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={`${fill * 100} 100`}
            transform="rotate(-90 16 16)"
          />
          <text
            x="16"
            y="16"
            textAnchor="middle"
            dominantBaseline="central"
            fill="currentColor"
            fontSize="9"
            fontWeight="500"
          >
            {known ? Math.round(fill * 100) : "?"}
          </text>
        </svg>
      </button>
      {open && (
        <div
          className="context-details"
          role="group"
          aria-label="Context usage"
          id={id}
        >
          <div className="context-heading">
            <strong>Context</strong>
            <span>
              {known ? `${Math.round(fill * 100)}% used` : "Not reported yet"}
            </span>
          </div>
          <p>
            {known && usage
              ? `${tokens(usage.contextTokens)} of ${tokens(contextMax)} tokens`
              : "Usage appears when the provider reports it."}
          </p>
          {usage && usage.turns > 0 && (
            <dl>
              <div>
                <dt>Input</dt>
                <dd>
                  {tokens(
                    thread?.provider === "codex"
                      ? usage.input
                      : usage.input + usage.cacheRead + usage.cacheWrite,
                  )}
                </dd>
              </div>
              <div>
                <dt>Output</dt>
                <dd>{tokens(usage.output)}</dd>
              </div>
              <div>
                <dt>Cache read</dt>
                <dd>{tokens(usage.cacheRead)}</dd>
              </div>
              <div>
                <dt>Cache write</dt>
                <dd>{tokens(usage.cacheWrite)}</dd>
              </div>
              {usage.costUsd > 0 && (
                <div>
                  <dt>Cost</dt>
                  <dd>{cost(usage.costUsd)}</dd>
                </div>
              )}
            </dl>
          )}
          {thread?.externalId && onCompact && (
            <button
              className="btn"
              type="button"
              disabled={thread.running || !connected}
              onClick={onCompact}
            >
              {thread.compacting ? "Compacting…" : "Compact context"}
            </button>
          )}
          <div className="context-connection">
            {connected
              ? thread?.running
                ? "Provider working"
                : "Connected"
              : "Reconnecting…"}
          </div>
        </div>
      )}
    </div>
  );
}
