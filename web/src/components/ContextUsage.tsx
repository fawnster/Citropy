import { AnimatePresence, motion } from "motion/react";
import { useReducedMotion } from "../lib/use-reduced-motion.ts";
import { useId, useState } from "react";
import { Minimize2 } from "lucide-react";
import { cost, tokens } from "../lib/format.ts";
import { useApp } from "../lib/store.ts";
import { useI18n } from "../lib/i18n.ts";
import { selectedModel } from "../../../shared/model-options.ts";

export function ContextUsage({ onCompact }: { onCompact?: () => void }) {
  const t = useI18n();
  const reducedMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const id = useId();
  const connected = useApp((state) => state.connected);
  const thread = useApp((state) => state.threads[state.activeThreadId ?? ""]);
  const provider = useApp((state) => state.providers.find((entry) => entry.id === thread?.provider));
  const usage = thread?.usage;
  const model = selectedModel(provider?.models ?? [], thread?.model);
  const reported = Boolean(usage && (usage.contextTokens > 0 || usage.contextMax > 0));
  const fresh = !thread?.externalId && !thread?.running && !usage?.turns;
  const contextMax = (usage?.contextMax || thread?.contextWindow || model?.contextMax) ?? 0;
  const known = Boolean(contextMax > 0 && (reported || fresh));
  const contextTokens = fresh ? 0 : usage?.contextTokens ?? 0;
  const fill =
    known
      ? Math.max(0, Math.min(contextTokens / contextMax, 1))
      : 0;
  const label = known
    ? t("{percent}% context used", { percent: Math.round(fill * 100) })
    : t("Context usage");

  return (
    <div
      className="context-usage"
      onFocus={(event) => {
        if (event.target.matches(":focus-visible")) setOpen(true);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.currentTarget.querySelector<HTMLButtonElement>(".context-ring")?.focus({ preventScroll: true });
          setOpen(false);
          event.stopPropagation();
        }
      }}
    >
      <button
        className="context-ring"
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onPointerDown={(event) => event.preventDefault()}
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
            {known || fresh ? Math.round(fill * 100) : ""}
          </text>
        </svg>
      </button>
      <AnimatePresence>{open && (
        <motion.div initial={{ opacity: 0, y: reducedMotion ? 0 : 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reducedMotion ? 0 : 4, pointerEvents: "none" }} transition={{ duration: reducedMotion ? 0 : 0.16 }}
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
                  used: tokens(contextTokens),
                  total: tokens(contextMax),
                })
              : t("Usage appears when the provider reports it.")}
          </p>
          {usage && reported && !fresh && (<>
            <p className="context-totals-label">{t("Conversation totals")}</p>
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
          </>)}
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
          {!connected && <div className="context-connection">{t("Reconnecting…")}</div>}
        </motion.div>
      )}</AnimatePresence>
    </div>
  );
}
