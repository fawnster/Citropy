import { useI18n } from "../lib/i18n.ts";
import { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { onTerminal, send } from "../lib/socket.ts";
import { useApp } from "../lib/store.ts";
import type { PanelTab } from "../../../shared/workbench.ts";

const DARK = {
  background: "#101010",
  foreground: "#dedede",
  cursor: "#ededed",
  cursorAccent: "#101010",
  selectionBackground: "rgba(255,255,255,0.18)",
  black: "#1e1e1e",
  red: "#f4657a",
  green: "#3ecf8e",
  yellow: "#ffc453",
  blue: "#7d9cff",
  magenta: "#c98bff",
  cyan: "#5fd7d0",
  white: "#c8c8c8",
  brightBlack: "#737373",
  brightRed: "#ff8a9b",
  brightGreen: "#6ee7a8",
  brightYellow: "#ffd479",
  brightBlue: "#9aa8ff",
  brightMagenta: "#dcaaff",
  brightCyan: "#7fe8e2",
  brightWhite: "#f2f2f2",
};

const LIGHT = {
  ...DARK,
  background: "#f8f8f8",
  foreground: "#262626",
  cursor: "#252525",
  cursorAccent: "#f8f8f8",
  selectionBackground: "rgba(0,0,0,0.15)",
  black: "#303030",
  white: "#525252",
  brightBlack: "#8a8a8a",
  brightWhite: "#171717",
  red: "#b4233f",
  green: "#127548",
  yellow: "#906000",
  blue: "#345bcc",
  magenta: "#8d3db2",
  cyan: "#087d82",
  brightRed: "#be244b",
  brightGreen: "#17824a",
  brightYellow: "#966600",
  brightBlue: "#345ed7",
  brightMagenta: "#9645bd",
  brightCyan: "#07808a",
};

function hasWebgl2(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2");
    const lose = context?.getExtension("WEBGL_lose_context");
    lose?.loseContext();
    return Boolean(context);
  } catch {
    return false;
  }
}

export function TerminalPane({
  active,
  panel,
}: {
  active: boolean;
  panel: PanelTab;
}) {
  const t = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const attached = useRef(false);
  const projectId = panel.projectId;
  const connected = useApp((state) => state.connected);
  const theme = useApp((state) => state.theme);

  useEffect(() => {
    if (!connected) attached.current = false;
    if (term.current) term.current.options.cursorBlink = active && connected;
    if (!active || !connected || !host.current) return;
    if (term.current) {
      fit.current?.fit();
      if (!attached.current) {
        term.current.reset();
        attached.current = true;
        send({
          t: "term.open",
          termId: panel.id,
          projectId,
          cols: term.current.cols,
          rows: term.current.rows,
        });
      }
      term.current.focus();
      return;
    }
    let disposed = false;

    void (async () => {
      const [{ Terminal: Xterm }, { FitAddon: Fit }, { WebLinksAddon }] =
        await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
          import("@xterm/addon-web-links"),
        ]);
      if (disposed || !host.current) return;

      const instance = new Xterm({
        fontFamily: "'JetBrains Mono Variable', ui-monospace, monospace",
        fontSize: 12,
        lineHeight: 1.35,
        letterSpacing: 0,
        cursorBlink: true,
        cursorStyle: "bar",
        allowProposedApi: true,
        scrollback: 8000,
        theme: theme === "light" ? LIGHT : DARK,
      });
      const fitAddon = new Fit();
      instance.loadAddon(fitAddon);
      instance.loadAddon(new WebLinksAddon());
      instance.open(host.current);

      if (hasWebgl2()) {
        try {
          const { WebglAddon } = await import("@xterm/addon-webgl");
          if (disposed) {
            instance.dispose();
            return;
          }
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => webgl.dispose());
          instance.loadAddon(webgl);
        } catch {
          /* dom renderer stays in place */
        }
      }

      if (disposed) {
        instance.dispose();
        return;
      }
      fitAddon.fit();
      term.current = instance;
      fit.current = fitAddon;
      attached.current = true;

      send({
        t: "term.open",
        termId: panel.id,
        projectId,
        cols: instance.cols,
        rows: instance.rows,
      });

      instance.onData((data) =>
        send({ t: "term.data", termId: panel.id, data }),
      );
      instance.onResize(({ cols, rows }) =>
        send({ t: "term.resize", termId: panel.id, cols, rows }),
      );
      instance.focus();
    })();

    return () => {
      disposed = true;
    };
  }, [active, projectId, connected, panel.id]);

  useEffect(() => {
    return onTerminal((event) => {
      if (event.termId !== panel.id) return;
      if (event.t === "term.data") term.current?.write(event.data);
      else
        term.current?.writeln(`\r\n${t("[process exited with code {code}]", { code: event.code ?? "?" })}`);
    });
  }, [panel.id, t]);

  useEffect(() => {
    if (!term.current) return;
    term.current.options.theme = theme === "light" ? LIGHT : DARK;
  }, [theme]);

  useEffect(() => {
    if (!active || !connected || !host.current) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        try {
          fit.current?.fit();
        } catch {
          /* not measurable yet */
        }
      });
    });
    observer.observe(host.current);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [active, connected]);

  useEffect(() => {
    return () => {
      term.current?.dispose();
      term.current = null;
      fit.current = null;
      attached.current = false;
    };
  }, []);

  return (
    <div className="terminal-pane">
      {!connected && (
        <div className="browser-notice">{t("Reconnecting to your terminal…")}</div>
      )}
      <div className="term" ref={host} />
    </div>
  );
}
