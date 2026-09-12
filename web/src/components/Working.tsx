import { useEffect, useState } from "react";
import { motion } from "motion/react";
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
};

export function Working({ status, tool, compacting, startedAt }: Props) {
  const t = useI18n();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, []);

  const text = compacting ? t("Compacting context") : tool ? `${t("Running")} ${tool}` : t((status && LABEL[status]) || "Working");

  return (
    <motion.div
      className="working"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
    >
      <span className="working-weave" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="working-text" role="status">{text}</span>
      <span className="working-time mono">{duration(Math.max(0, now - startedAt))}</span>
    </motion.div>
  );
}
