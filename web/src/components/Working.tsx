import { useEffect, useState, type CSSProperties } from "react";
import type { ThreadStatus } from "../../../shared/protocol.ts";
import { duration } from "../lib/format.ts";
import { useI18n } from "../lib/i18n.ts";

interface Props {
  status: ThreadStatus | undefined;
  tool?: string;
  compacting?: boolean;
  startedAt: number;
}

const LABEL: Partial<Record<ThreadStatus, string>> = {
  queued: "Queued",
  thinking: "Thinking",
  working: "Working",
  awaiting: "Needs input",
};

export function Working({ status, tool, compacting, startedAt }: Props) {
  const t = useI18n();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let timer = 0;
    const update = () => {
      clearTimeout(timer);
      if (document.hidden) return;
      const now = Date.now();
      setNow(now);
      timer = window.setTimeout(update, now - startedAt < 10_000 ? 100 : 1000);
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [startedAt]);

  const text = compacting ? t("Compacting context") : tool ? `${t("Running")} ${tool}` : t((status && LABEL[status]) || "Working");

  return (
    <span className="working">
      <span className="working-grid" aria-hidden="true">
        {Array.from({ length: 9 }, (_, index) => <i key={index} style={{ "--pixel-delay": `${(Math.floor(index / 3) + index % 3) * -120}ms` } as CSSProperties} />)}
      </span>
      <span className="working-text" role="status">{text}</span>
      <span className="working-time mono">{duration(Math.max(0, now - startedAt))}</span>
    </span>
  );
}
