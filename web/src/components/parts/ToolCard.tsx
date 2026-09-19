import { useMemo } from "react";
import { useI18n } from "../../lib/i18n.ts";
import { useDisclosure } from "../../lib/use-disclosure.ts";
import { Collapsible } from "../Collapsible.tsx";
import { AlertTriangle, Ban, Check, ChevronRight, ExternalLink, shapeIcon } from "../icons.ts";
import { toolLabel } from "../../lib/group.ts";
import { DiffView } from "../DiffView.tsx";
import { ansiToHtml, stripAnsi } from "../../lib/ansi.ts";
import { duration } from "../../lib/format.ts";
import type { ToolPart } from "../../../../shared/protocol.ts";

export function ToolCard({ part }: { part: ToolPart }) {
  const t = useI18n();
  const [open, setOpen] = useDisclosure(part.id, "tool");
  const Icon = shapeIcon[part.shape];
  const elapsed = part.endedAt ? part.endedAt - part.startedAt : null;
  const output = part.output ?? "";
  const hasImages = Boolean(part.images?.length || part.imageFiles?.length);

  const peek = useMemo(() => {
    if (part.status === "running") return null;
    if (part.patch) return null;
    const clean = stripAnsi(output).trim();
    if (!clean) return null;
    const first = clean.split("\n").find((line) => line.trim().length > 0) ?? "";
    return first.length > 120 ? `${first.slice(0, 120)}…` : first;
  }, [output, part.patch, part.status]);

  const url = part.shape === "web" ? part.headline : null;

  return (
    <div id={`tool-${part.id}`} className="tool" data-shape={part.shape} data-status={part.status} data-open={open}>
      <button className="tool-head" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ChevronRight size={12} className="tool-chevron" />
        <span className="tool-icon">
          <Icon size={13} />
        </span>
        <span className="tool-name">{toolLabel(part.name, part.status, t)}</span>
        <span className="tool-headline mono truncate">{part.headline}</span>
        <span className="tool-meta">
          {part.detail && <span className="tool-detail truncate">{part.detail}</span>}
          {part.patch && (
            <span className="tool-stat">
              {part.patch.added > 0 && <span className="diff-plus">+{part.patch.added}</span>}
              {part.patch.removed > 0 && <span className="diff-minus">-{part.patch.removed}</span>}
            </span>
          )}
          {elapsed !== null && elapsed > 400 && <span className="tool-time">{duration(elapsed)}</span>}
          <StatusMark status={part.status} />
        </span>
      </button>

      {!open && peek && <div className="tool-peek mono truncate">{peek}</div>}

      <Collapsible open={open} className="tool-body">
        <div className="tool-body-inner">
          {url && (
            <a className="tool-url mono truncate" href={url} target="_blank" rel="noreferrer noopener">
              {url}
              <ExternalLink size={11} />
            </a>
          )}
          {part.patch && <DiffView patch={part.patch} showHeader={false} partId={part.id} />}
          {!part.patch && output && <Output text={output} shape={part.shape} partId={part.id} />}
          {!part.patch && !output && !hasImages && part.status === "running" && (
            <div className="tool-waiting">
              <span className="tool-waiting-bar" />
              {t("Running")}
            </div>
          )}
          {!part.patch && !output && !hasImages && part.status !== "running" && (
            <div className="tool-empty">{t("No output")}</div>
          )}
        </div>
      </Collapsible>
    </div>
  );
}

function StatusMark({ status }: { status: ToolPart["status"] }) {
  const t = useI18n();
  if (status === "running") return <span className="tool-spin" aria-label={t("running")} />;
  if (status === "ok") return <Check size={12} className="tool-ok" aria-label={t("done")} />;
  if (status === "denied") return <Ban size={12} className="tool-bad" aria-label={t("denied")} />;
  return <AlertTriangle size={12} className="tool-bad" aria-label={t("failed")} />;
}

function Output({ text, shape, partId }: { text: string; shape: ToolPart["shape"]; partId: string }) {
  const t = useI18n();
  const [expanded, setExpanded] = useDisclosure(partId, "output");
  const lines = useMemo(() => text.split("\n"), [text]);
  const cap = shape === "command" ? 18 : 14;
  const shown = expanded ? lines : lines.slice(0, cap);
  const hidden = lines.length - shown.length;
  const html = useMemo(() => ansiToHtml(shown.join("\n")), [shown]);

  return (
    <>
      <pre className="tool-output" dangerouslySetInnerHTML={{ __html: html }} />
      {hidden > 0 && (
        <button className="diff-more" type="button" onClick={() => setExpanded(true)}>
          {t("Show {count} more {unit}", { count: hidden, unit: hidden === 1 ? t("line") : t("lines") })}
        </button>
      )}
    </>
  );
}
