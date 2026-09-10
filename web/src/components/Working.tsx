import { useEffect, useState } from "react";
import { motion } from "motion/react";
import type { ThreadStatus } from "../../../shared/protocol.ts";
import { duration } from "../lib/format.ts";

interface Props {
  status: ThreadStatus | undefined;
  tool?: string;
}

const LABEL: Partial<Record<ThreadStatus, string>> = {
  queued: "Queued",
  thinking: "Thinking",
  working: "Working",
};

export function Working({ status, tool }: Props) {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, []);

  const text = tool ? `Running ${tool}` : (status && LABEL[status]) || "Working";

  return (
    <motion.div
      className="working"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
    >
      <span className="working-weave" aria-hidden="true">
        <i style={{ width: "100%", animationDelay: "0ms" }} />
        <i style={{ width: "72%", animationDelay: "140ms" }} />
        <i style={{ width: "86%", animationDelay: "280ms" }} />
      </span>
      <span className="working-text">{text}</span>
      <span className="working-time mono">{duration(now - start)}</span>
    </motion.div>
  );
}
