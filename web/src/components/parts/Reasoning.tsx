import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Brain, ChevronRight } from "../icons.ts";
import { Collapsible } from "../Collapsible.tsx";
import { useApp } from "../../lib/store.ts";

interface Props {
  text: string;
  live: boolean;
}

function tail(text: string): string {
  const trimmed = text.trimEnd();
  const cut = trimmed.slice(-260);
  return cut.length < trimmed.length ? `…${cut}` : cut;
}

export function Reasoning({ text, live }: Props) {
  const [open, setOpen] = useState(false);
  const streaming = useApp((state) => state.textStreaming);
  if (!text.trim() || (!streaming && live)) return null;

  const words = text.trim().split(/\s+/).length;

  return (
    <div className="reason" data-open={open}>
      <button className="reason-head" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ChevronRight size={13} className="reason-chevron" />
        <Brain size={13} />
        <span>{live ? "Thinking" : "Thought"}</span>
        <span className="reason-count">{words} words</span>
      </button>

      <Collapsible open={open} className="reason-body">
        <div className="reason-text">{text}</div>
      </Collapsible>
      <AnimatePresence initial={false}>
        {!open && live && (
          <motion.div
            key="tail"
            className="reason-ticker"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            {tail(text)}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
