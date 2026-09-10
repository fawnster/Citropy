import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import type { DesktopWindowState } from "../desktop.d.ts";

export function WindowControls() {
  const [state, setState] = useState<DesktopWindowState>();
  useEffect(() => {
    void window.citropyDesktop?.windowState?.().then((state) => {
      setState(state);
      document.documentElement.dataset.platform = state.platform;
    });
    return window.citropyDesktop?.onWindowState?.(setState);
  }, []);
  if (!window.citropyDesktop?.windowCommand || state?.platform === "darwin")
    return null;
  return (
    <div className="window-controls" role="group" aria-label="Window controls">
      <button
        type="button"
        aria-label="Minimize window"
        title="Minimize"
        onClick={() => void window.citropyDesktop?.windowCommand("minimize")}
      >
        <Minus size={15} />
      </button>
      <button
        type="button"
        aria-label={state?.maximized ? "Restore window" : "Maximize window"}
        title={state?.maximized ? "Restore" : "Maximize"}
        onClick={() => void window.citropyDesktop?.windowCommand("maximize")}
      >
        {state?.maximized ? <Copy size={12} /> : <Square size={12} />}
      </button>
      <button
        type="button"
        className="window-close"
        aria-label="Close window"
        title="Close window"
        onClick={() => void window.citropyDesktop?.windowCommand("close")}
      >
        <X size={16} />
      </button>
    </div>
  );
}
