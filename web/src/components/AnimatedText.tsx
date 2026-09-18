import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { useReducedMotion } from "../lib/use-reduced-motion.ts";

export function AnimatedText({ text, className = "" }: { text: string; className?: string }) {
  const reducedMotion = useReducedMotion();
  return <span className={`animated-text ${className}`}>
    {reducedMotion ? <span>{text}</span> : <AnimatePresence initial={false}>
      <TextTransition key={text} text={text} />
    </AnimatePresence>}
  </span>;
}

function TextTransition({ text }: { text: string }) {
  const present = useIsPresent();
  return <motion.span
    aria-hidden={!present || undefined}
    data-exiting={!present || undefined}
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    exit={{ opacity: 0 }}
    transition={{ duration: 0.18, ease: "easeInOut" }}
  >{text}</motion.span>;
}
