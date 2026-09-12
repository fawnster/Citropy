import { useId, useState } from "react";
import { Minimize2 } from "lucide-react";
import { cost, tokens } from "../lib/format.ts";
import { useApp } from "../lib/store.ts";
import { useI18n } from "../lib/i18n.ts";

export function ContextUsage({ onCompact }: { onCompact?: () => void }) {
  const t = useI18n();
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
    ? t("{percent}% context used", { percent: Math.round(fill * 100) })
    : t("Context usage");

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
          aria-label={t("Context usage")}
          id={id}
        >
          <div className="context-heading">
            <strong>{t("Context")}</strong>
            <span>
              {known
                ? t("{percent}% context used", { percent: Math.round(fill * 100) })
                : t("Not reported yet")}
            </span>
          </div>
          <p>
            {known && usage
              ? t("{used} of {total} tokens", {
                  used: tokens(usage.contextTokens),
                  total: tokens(contextMax),
                })
              : t("Usage appears when the provider reports it.")}
          </p>
          {usage && usage.turns > 0 && (
            <dl>
              <div>
                <dt>{t("Input")}</dt>
                <dd>
                  {tokens(
                    thread?.provider === "codex"
                      ? usage.input
                      : usage.input + usage.cacheRead + usage.cacheWrite,
                  )}
                </dd>
              </div>
              <div>
                <dt>{t("Output")}</dt>
                <dd>{tokens(usage.output)}</dd>
              </div>
              <div>
                <dt>{t("Cache read")}</dt>
                <dd>{tokens(usage.cacheRead)}</dd>
              </div>
              <div>
                <dt>{t("Cache write")}</dt>
                <dd>{tokens(usage.cacheWrite)}</dd>
              </div>
              {usage.costUsd > 0 && (
                <div>
                  <dt>{t("Cost")}</dt>
                  <dd>{cost(usage.costUsd)}</dd>
                </div>
              )}
            </dl>
          )}
          {thread?.compacting ? (
            <div className="context-compacting" role="status">
                <Minimize2 size={15} />{t("Compacting context")}…
            </div>
          ) : thread?.externalId && onCompact && (
            <div className="context-actions">
              <button className="btn" type="button" disabled={thread.running || !connected} onClick={onCompact}>
                <Minimize2 size={15} />{t("Compact context")}
              </button>
            </div>
          )}
          {!thread?.compacting && <div className="context-connection">
            {connected
              ? thread?.running
                ? t("Provider working")
                : t("Connected")
              : t("Reconnecting…")}
          </div>}
        </div>
      )}
    </div>
  );
}
