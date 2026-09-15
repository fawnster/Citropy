import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useReducedMotion } from "../lib/use-reduced-motion.ts";

export function SlidingPanel({ open, side, keepMounted = false, children }: {
  open: boolean;
  side: "left" | "right";
  keepMounted?: boolean;
  children: ReactNode;
}) {
  const reducedMotion = useReducedMotion();
  const [present, setPresent] = useState(open);
  const [animate, setAnimate] = useState(false);
  const duration = reducedMotion ? 0 : 200;
  useEffect(() => {
    let ready = 0;
    const frame = requestAnimationFrame(() => {
      ready = requestAnimationFrame(() => setAnimate(true));
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(ready);
    };
  }, []);
  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    const timer = window.setTimeout(() => setPresent(false), duration);
    return () => clearTimeout(timer);
  }, [open, duration]);
  if (!open && !present && !keepMounted) return null;
  return <div
    className="sliding-panel"
    data-side={side}
    data-open={open}
    data-animate={animate}
    hidden={!open && !present}
    inert={!open}
    aria-hidden={!open || undefined}
    style={{ "--panel-duration": `${duration}ms` } as CSSProperties}
  >{children}</div>;
}
