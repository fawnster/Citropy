import { useDisclosure } from "../../lib/use-disclosure.ts";
import { useI18n } from "../../lib/i18n.ts";
import { AnimatePresence, motion } from "motion/react";
import { Brain, ChevronRight } from "../icons.ts";
import { Collapsible } from "../Collapsible.tsx";
import { useApp } from "../../lib/store.ts";

interface Props {
  partId: string;
  text: string;
  live: boolean;
}

function tail(text: string): string {
  const trimmed = text.trimEnd();
  const cut = trimmed.slice(-260);
  return cut.length < trimmed.length ? `…${cut}` : cut;
}

export function Reasoning({ partId, text, live }: Props) {
  const t = useI18n();
  const [open, setOpen] = useDisclosure(partId, "reasoning");
  const streaming = useApp((state) => state.textStreaming);
  if (!text.trim() || (!streaming && live)) return null;

  const words = text.trim().split(/\s+/).length;

  return (
    <div className="reason" data-open={open}>
      <button className="reason-head" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ChevronRight size={13} className="reason-chevron" />
        <Brain size={13} />
        <span>{live ? t("Thinking") : t("Thought")}</span>
        <span className="reason-count">{words} {t("words")}</span>
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
