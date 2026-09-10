import { useEffect, useRef, useState } from "react";
import {
  setPanelWidth,
  useApp,
  viewportWidth,
  type PanelId,
} from "../lib/store.ts";

const labels: Record<PanelId, string> = {
  sidebar: "Sidebar width",
  inspector: "Inspector width",
  git: "Git list width",
  github: "GitHub list width",
};

export function ResizeHandle({
  panel,
  inline = false,
}: {
  panel: PanelId;
  inline?: boolean;
}) {
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    x: number;
    width: number;
    root: HTMLElement;
    previous: string;
    moved: boolean;
  } | null>(null);
  const uiScale = useApp((state) => state.uiScale);
  const property = `--${panel}-width`;
  const direction = panel === "inspector" ? -1 : 1;
  const minimum = panel === "sidebar" ? 216 : panel === "inspector" ? 260 : 240;
  const [width, setWidth] = useState(minimum);
  const pane = () =>
    (inline
      ? handle.current?.previousElementSibling
      : handle.current?.parentElement) as HTMLElement | null;
  const maximum = () => {
    const viewport = viewportWidth();
    if (panel === "sidebar")
      return Math.max(minimum, Math.min(440, viewport * 0.34));
    if (panel === "inspector") {
      const root = handle.current?.closest(".shell");
      const sidebar =
        root?.querySelector(".shell-body > .rail")?.getBoundingClientRect()
          .width ?? 0;
      return Math.max(
        minimum,
        Math.min(720, viewport - sidebar / (uiScale / 100) - 360),
      );
    }
    const available =
      (pane()?.parentElement?.getBoundingClientRect().width ?? 0) /
      (uiScale / 100);
    return Math.max(minimum, Math.min(640, available - 360));
  };
  const clamp = (value: number) =>
    Math.round(Math.max(minimum, Math.min(maximum(), value)));
  const cancel = () => {
    const current = drag.current;
    if (!current) return;
    if (current.previous)
      current.root.style.setProperty(property, current.previous);
    else current.root.style.removeProperty(property);
    drag.current = null;
    delete document.documentElement.dataset.resizing;
  };

  useEffect(() => {
    const element = pane();
    if (!element) return;
    const measure = () =>
      setWidth(
        Math.round(element.getBoundingClientRect().width / (uiScale / 100)),
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancel();
    };
  }, [uiScale, inline, panel]);

  return (
    <div
      ref={handle}
      className="panel-resize"
      data-inline={inline || undefined}
      data-edge={direction === -1 ? "left" : "right"}
      role="separator"
      aria-label={labels[panel]}
      aria-orientation="vertical"
      aria-valuemin={minimum}
      aria-valuemax={Math.round(maximum())}
      aria-valuenow={width}
      aria-valuetext={`${width} pixels`}
      tabIndex={0}
      title="Drag to resize. Double-click or press Enter to reset."
      onDoubleClick={() => setPanelWidth(panel)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const element = pane();
        const root = handle.current?.closest<HTMLElement>(".shell");
        if (!element || !root) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          x: event.clientX,
          width: element.getBoundingClientRect().width / (uiScale / 100),
          root,
          previous: root.style.getPropertyValue(property),
          moved: false,
        };
        document.documentElement.dataset.resizing = "true";
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current) return;
        current.moved = true;
        const next = clamp(
          current.width +
            (direction * (event.clientX - current.x)) / (uiScale / 100),
        );
        current.root.style.setProperty(property, `${next}px`);
      }}
      onPointerUp={(event) => {
        const current = drag.current;
        if (!current) return;
        drag.current = null;
        delete document.documentElement.dataset.resizing;
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
        if (current.moved)
          setPanelWidth(
            panel,
            clamp(
              current.width +
                (direction * (event.clientX - current.x)) / (uiScale / 100),
            ),
          );
      }}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          cancel();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          setPanelWidth(panel);
          return;
        }
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        const step = event.shiftKey ? 32 : 10;
        const next =
          event.key === "Home"
            ? minimum
            : event.key === "End"
              ? maximum()
              : width +
                (event.key === "ArrowRight" ? 1 : -1) * direction * step;
        setPanelWidth(panel, clamp(next));
      }}
    />
  );
}
