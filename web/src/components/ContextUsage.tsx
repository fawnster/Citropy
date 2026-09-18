import { AnimatePresence, motion } from "motion/react";
import { useReducedMotion } from "../lib/use-reduced-motion.ts";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Minimize2 } from "lucide-react";
import { cost, tokens } from "../lib/format.ts";
import { useApp, viewportWidth } from "../lib/store.ts";
import { useI18n } from "../lib/i18n.ts";
import { selectedModel } from "../../../shared/model-options.ts";
import { ContextInspector } from "./ContextInspector.tsx";

export function ContextUsage({ onCompact, draft = "" }: { onCompact?: () => void; draft?: string }) {
  const t = useI18n();
  const reducedMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const id = useId();
  const ring = useRef<HTMLButtonElement>(null);
  const details = useRef<HTMLDivElement>(null);
  const uiScale = useApp((state) => state.uiScale);
  const connected = useApp((state) => state.connected);
  const thread = useApp((state) => state.threads[state.activeThreadId ?? ""]);
  const provider = useApp((state) => state.providers.find((entry) => entry.id === thread?.provider));
  const usage = thread?.usage;
  const totals = [...(thread?.transfers ?? []), ...(thread ? [thread] : [])].reduce((sum, session) => ({
    input: sum.input + (session.provider === "codex" ? Math.max(0, session.usage.input - session.usage.cacheRead - session.usage.cacheWrite) : session.usage.input),
    output: sum.output + session.usage.output,
    cacheRead: sum.cacheRead + session.usage.cacheRead,
    cacheWrite: sum.cacheWrite + session.usage.cacheWrite,
    costUsd: sum.costUsd + session.usage.costUsd,
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 });
  const model = selectedModel(provider?.models ?? [], thread?.model);
  const contextMax = (usage?.contextMax || thread?.contextWindow || model?.contextMax) ?? 0;
  const reported = Boolean(usage && usage.contextTokens > 0 && (!contextMax || usage.contextTokens <= contextMax));
  const hasTotals = Boolean(totals.input || totals.output || totals.cacheRead || totals.cacheWrite || totals.costUsd);
  const fresh = !thread?.externalId && !thread?.running && !usage?.turns && !(usage?.input || usage?.output || usage?.cacheRead || usage?.cacheWrite || usage?.costUsd);
  const known = Boolean(contextMax > 0 && (reported || fresh));
  const contextTokens = fresh ? 0 : usage?.contextTokens ?? 0;
  const totalProcessed = totals.input + totals.cacheRead + totals.cacheWrite + totals.output;
  const fill =
    known
      ? Math.max(0, Math.min(contextTokens / contextMax, 1))
      : 0;
  const label = known
    ? t("{percent}% context used", { percent: Math.round(fill * 100) })
    : t("Context usage");

  useLayoutEffect(() => {
    const panel = details.current;
    const anchor = ring.current;
    if (!open || !panel || !anchor) return;
    panel.showPopover();
    const position = () => {
      const bounds = anchor.getBoundingClientRect();
      const scale = uiScale / 100;
      const width = Math.min(252, viewportWidth() - 24);
      panel.style.width = `${width}px`;
      panel.style.maxHeight = `${Math.max(0, bounds.top / scale - 20)}px`;
      panel.style.left = `${Math.max(12, Math.min(bounds.right / scale - width, viewportWidth() - width - 12))}px`;
      panel.style.top = `${Math.max(12, bounds.top / scale - panel.offsetHeight - 8)}px`;
    };
    position();
    const resize = new ResizeObserver(position);
    resize.observe(panel);
    resize.observe(anchor);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      resize.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open, uiScale]);

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
        ref={ring}
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
          ref={details}
          popover="manual"
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
                : t(reported ? "Window size unavailable" : "Not reported yet")}
            </span>
          </div>
          <p>
            {known && usage
              ? t("{used} of {total} tokens", {
                  used: tokens(contextTokens),
                  total: tokens(contextMax),
                })
              : reported
                ? t("{used} tokens used", { used: tokens(contextTokens) })
                : contextMax > 0
                  ? t("Window size: {total} tokens", { total: tokens(contextMax) })
                  : t("Usage appears when the provider reports it.")}
          </p>
          {usage && hasTotals && (
            <details className="context-totals">
              <summary>
                <span>{t("Total processed")}</span>
                <strong>{tokens(totalProcessed)}</strong>
                <ChevronDown size={13} aria-hidden="true" />
              </summary>
              <p>{t("Across all requests, including reused context.")}</p>
              <dl>
                <div>
                  <dt>{t("Uncached input")}</dt>
                  <dd>{tokens(totals.input)}</dd>
                </div>
                <div>
                  <dt>{t("Output")}</dt>
                  <dd>{tokens(totals.output)}</dd>
                </div>
                <div>
                  <dt>{t("Cache read")}</dt>
                  <dd>{tokens(totals.cacheRead)}</dd>
                </div>
                <div>
                  <dt>{t("Cache write")}</dt>
                  <dd>{tokens(totals.cacheWrite)}</dd>
                </div>
                {totals.costUsd > 0 && (
                  <div>
                    <dt>{t("Estimated cost")}</dt>
                    <dd>{cost(totals.costUsd)}</dd>
                  </div>
                )}
              </dl>
            </details>
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
          {!connected && <div className="context-connection">{t("Reconnecting…")}</div>}
          <button type="button" className="btn" onClick={() => setInspecting(true)}>{t("Inspect context sources")}</button>
        </motion.div>
      )}</AnimatePresence>
      <AnimatePresence>{inspecting && thread && <ContextInspector thread={thread} draft={draft} onClose={() => setInspecting(false)} />}</AnimatePresence>
    </div>
  );
}
