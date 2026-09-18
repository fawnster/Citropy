import { useI18n } from "../lib/i18n.ts";
import { useRef, useState } from "react";
import { motion } from "motion/react";
import { useReducedMotion } from "../lib/use-reduced-motion.ts";
import { GitBranch, Github, Settings, BarChart3 } from "lucide-react";

import { AppUpdateControl } from "./AppUpdateControl.tsx";

export function SidebarFooter({
  onGit,
  onGitHub,
  onSettings,
  onUsage,
  activeView,
}: {
  onGit: () => void;
  onGitHub: () => void;
  onSettings: () => void;
  onUsage: () => void;
  activeView?: string;
}) {
  const t = useI18n();
  const [compact, setCompact] = useState(
    () => localStorage.getItem("citropy.compactNavigation") !== "0",
  );
  const drag = useRef<number | undefined>(undefined);
  const moved = useRef(false);
  const reducedMotion = useReducedMotion();
  const change = (value: boolean) => {
    setCompact(value);
    localStorage.setItem("citropy.compactNavigation", value ? "1" : "0");
  };
  const actions = [
    { name: "Source control", icon: GitBranch, run: onGit, tone: "git" },
    { name: "GitHub", icon: Github, run: onGitHub, tone: "github" },
    { name: "Usage", icon: BarChart3, run: onUsage, tone: "usage" },
    { name: "Settings", icon: Settings, run: onSettings, tone: "settings" },
  ];
  return (
    <div className="rail-footer navigation-footer" data-compact={compact}>
      <button
        type="button"
        className="navigation-handle"
        aria-label={t(compact ? "Expand navigation" : "Collapse navigation")}
        aria-expanded={!compact}
        title={t(compact ? "Drag up to show labels" : "Drag down for icons only")}
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
            if (compact !== distance > 0) change(distance > 0);
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
      />
      <nav className="navigation-actions" aria-label={t("Workspace navigation")}>
        {actions.map(({ name, icon: Icon, run, tone }) => (
          <motion.button
            layout="position"
            type="button"
            className="rail-action"
            data-tone={tone}
            aria-current={activeView === tone ? "page" : undefined}
            key={t(name)}
            onClick={run}
            aria-label={t(name)}
            title={compact ? t(name) : undefined}
            transition={{
              duration: reducedMotion ? 0 : 0.2,
              ease: [0.2, 0, 0, 1],
            }}
          >
            <Icon size={17} />
            <span>{t(name)}</span>
          </motion.button>
        ))}
        <span className="navigation-update-divider" aria-hidden="true" />
        <AppUpdateControl />
      </nav>
    </div>
  );
}
