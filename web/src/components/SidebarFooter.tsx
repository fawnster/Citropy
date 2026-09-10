import { useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  GitBranch,
  Github,
  Settings,
  BarChart3,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

export function SidebarFooter({
  onGit,
  onGitHub,
  onSettings,
  onUsage,
}: {
  onGit: () => void;
  onGitHub: () => void;
  onSettings: () => void;
  onUsage: () => void;
}) {
  const [compact, setCompact] = useState(
    () => localStorage.getItem("citropy.compactNavigation") === "1",
  );
  const drag = useRef<number | undefined>(undefined);
  const moved = useRef(false);
  const reducedMotion = useReducedMotion();
  const change = (value: boolean) => {
    setCompact(value);
    localStorage.setItem("citropy.compactNavigation", value ? "1" : "0");
  };
  const actions = [
    { name: "Source control", icon: GitBranch, run: onGit },
    { name: "GitHub", icon: Github, run: onGitHub },
    { name: "Settings", icon: Settings, run: onSettings },
    { name: "Usage", icon: BarChart3, run: onUsage },
  ];
  return (
    <div className="rail-footer navigation-footer" data-compact={compact}>
      <button
        type="button"
        className="navigation-handle"
        aria-label={compact ? "Expand navigation" : "Collapse navigation"}
        aria-expanded={!compact}
        title={compact ? "Drag up to show labels" : "Drag down for icons only"}
        onPointerDown={(event) => {
          drag.current = event.clientY;
          moved.current = false;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (drag.current === undefined) return;
          const distance = event.clientY - drag.current;
          if (Math.abs(distance) >= 20) {
            moved.current = true;
            if (compact !== (distance > 0)) change(distance > 0);
          }
        }}
        onPointerUp={() => {
          drag.current = undefined;
        }}
        onPointerCancel={() => {
          drag.current = undefined;
          moved.current = true;
        }}
        onClick={() => {
          if (!moved.current) change(!compact);
          moved.current = false;
        }}
      >
        <span />
        {compact ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        <span />
      </button>
      <nav className="navigation-actions" aria-label="Workspace navigation">
        {actions.map(({ name, icon: Icon, run }) => (
          <motion.button
            layout="position"
            type="button"
            className="rail-action"
            key={name}
            onClick={run}
            aria-label={name}
            title={compact ? name : undefined}
            transition={{
              duration: reducedMotion ? 0 : 0.2,
              ease: [0.2, 0, 0, 1],
            }}
          >
            <Icon size={17} />
            <span>{name}</span>
          </motion.button>
        ))}
      </nav>
    </div>
  );
}
