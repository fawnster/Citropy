import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Globe2,
  ArrowUpRight,
  Monitor,
  AlertCircle,
} from "lucide-react";
import { send } from "../lib/socket.ts";
import { useApp } from "../lib/store.ts";
import { BrowserViewport } from "./BrowserViewport.tsx";
import type { BrowserAction, PanelTab } from "../../../shared/workbench.ts";

export function BrowserPane({
  panel,
  active,
}: {
  panel: PanelTab;
  active: boolean;
}) {
  const state = useApp((store) => store.browsers[panel.id]);
  const connected = useApp((store) => store.connected);
  const uiScale = useApp((store) => store.uiScale);
  const native = Boolean(window.citropyDesktop);
  const [address, setAddress] = useState("");
  const [dialogText, setDialogText] = useState("");
  const [cover, setCover] = useState<string>();
  const screen = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const act = (action: BrowserAction) => {
    if (connected) send({ t: "browser.action", id: panel.id, input: action });
  };

  useEffect(() => {
    setAddress(state?.url === "about:blank" ? "" : (state?.url ?? ""));
  }, [state?.url]);
  useEffect(
    () =>
      window.citropyDesktop?.onAddressFocus((id) => {
        if (id === panel.id) {
          input.current?.focus();
          input.current?.select();
        }
      }),
    [panel.id],
  );
  useEffect(
    () =>
      window.citropyDesktop?.onBrowserCover((id, image) => {
        if (id === panel.id) setCover(image);
      }),
    [panel.id],
  );
  useEffect(() => {
    const desktop = window.citropyDesktop;
    const element = screen.current;
    if (!desktop || !element) return;
    if (!active || !connected || !state) {
      desktop.browserBounds(panel.id, null, false);
      setCover(undefined);
      return;
    }
    let previous = "";
    let frame = 0;
    const overlays =
      'dialog[open], [role="menu"], [role="dialog"], [aria-modal="true"]';
    const update = () => {
      const bounds = element.getBoundingClientRect();
      const overlay = document.querySelector(overlays);
      const visible =
        !state.dialog &&
        state.url !== "about:blank" &&
        !overlay &&
        bounds.width > 0 &&
        bounds.height > 0;
      const position = {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      };
      const covered = Boolean(overlay);
      const value = JSON.stringify([position, visible, covered]);
      if (value === previous) return;
      previous = value;
      desktop.browserBounds(panel.id, position, visible, covered);
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    update();
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    const observer = new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            record.type === "attributes" ||
            [...record.addedNodes, ...record.removedNodes].some(
              (node) =>
                node instanceof Element &&
                (node.matches(overlays) || node.querySelector(overlays)),
            ),
        )
      )
        schedule();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["open", "role", "aria-modal"],
    });
    window.addEventListener("resize", schedule);
    return () => {
      resize.disconnect();
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      cancelAnimationFrame(frame);
      desktop.browserBounds(panel.id, null, false);
    };
  }, [
    active,
    connected,
    panel.id,
    Boolean(state),
    state?.url,
    state?.dialog,
    uiScale,
  ]);

  return (
    <div className="browser-pane">
      <div className="browser-toolbar">
        <div className="browser-navigation">
          <button
            className="icon-btn"
            type="button"
            disabled={!native || !connected || !state?.canGoBack}
            title="Back"
            aria-label="Browser back"
            onClick={() => act({ action: "back" })}
          >
            <ArrowLeft size={14} />
          </button>
          <button
            className="icon-btn"
            type="button"
            disabled={!native || !connected || !state?.canGoForward}
            title="Forward"
            aria-label="Browser forward"
            onClick={() => act({ action: "forward" })}
          >
            <ArrowRight size={14} />
          </button>
          <button
            className="icon-btn"
            type="button"
            disabled={!native || !connected || !state}
            title="Reload"
            aria-label="Reload browser"
            onClick={() => act({ action: "reload" })}
          >
            <RotateCw size={13} className={state?.loading ? "spin" : ""} />
          </button>
        </div>
        <form
          className="browser-address"
          onSubmit={(event) => {
            event.preventDefault();
            if (address.trim()) act({ action: "navigate", url: address });
          }}
        >
          <input
            ref={input}
            value={address}
            disabled={!native || !connected || !state}
            onChange={(event) => setAddress(event.target.value)}
            aria-label="Browser address"
            placeholder="Enter a web address"
            spellCheck={false}
          />
          <button
            type="submit"
            disabled={!native || !address.trim() || !connected || !state}
            aria-label="Go to address"
          >
            <ArrowUpRight size={14} />
          </button>
        </form>
      </div>
      {native && state && (
        <BrowserViewport state={state} disabled={!connected} onResize={act} />
      )}
      {!connected && (
        <div className="browser-notice">Reconnecting to Citropy…</div>
      )}
      {state?.error && (
        <div className="browser-notice" role="alert">
          <AlertCircle size={14} />
          {state.error}
        </div>
      )}
      {state?.dialog && native && (
        <form
          className="browser-dialog"
          onSubmit={(event) => {
            event.preventDefault();
            act({ action: "dialog", accept: true, text: dialogText });
            setDialogText("");
          }}
        >
          <strong>This page says</strong>
          <p>{state.dialog.message}</p>
          {state.dialog.type === "prompt" && (
            <input
              value={dialogText}
              onChange={(event) => setDialogText(event.target.value)}
              aria-label="Browser dialog response"
              autoFocus
            />
          )}
          <div>
            <button
              type="button"
              className="btn"
              onClick={() => act({ action: "dialog", accept: false })}
            >
              Dismiss
            </button>
            <button type="submit" className="btn primary">
              OK
            </button>
          </div>
        </form>
      )}
      <div className="browser-screen" ref={screen} aria-label="Browser page">
        {native && cover && (
          <img
            className="browser-cover"
            src={cover}
            alt=""
            aria-hidden="true"
          />
        )}
        {!native ? (
          <div className="browser-start">
            <Monitor size={34} />
            <h3>Continue in Citropy desktop</h3>
            <p>
              The desktop app runs the browser directly, with normal scrolling,
              typing, and tabs shared with your provider.
            </p>
            <button
              type="button"
              className="btn primary"
              disabled={!connected}
              onClick={() => send({ t: "desktop.open" })}
            >
              Open Citropy desktop
              <ArrowUpRight size={14} />
            </button>
          </div>
        ) : (
          (!state || state.url === "about:blank") && (
            <div className="browser-start">
              <Globe2 size={34} />
              <h3>
                {state ? "Browse alongside your work" : "Opening browser…"}
              </h3>
              <p>
                {state
                  ? "Enter an address above, or ask your provider to open a page."
                  : "Preparing a browser for this workspace."}
              </p>
            </div>
          )
        )}
      </div>
      <div className="browser-footer">
        <span>
          <span className="browser-live" />
          {native
            ? `${state?.profileName ?? "Workspace"} · Shared with providers`
            : "Desktop browser"}
        </span>
        {native && state && (
          <span>Fit {Math.round((state.scale ?? 1) * 100)}%</span>
        )}
      </div>
    </div>
  );
}
