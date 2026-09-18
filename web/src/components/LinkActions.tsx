import { useEffect, useRef, useState } from "react";
import { ExternalLink, Globe2 } from "lucide-react";
import { Menu } from "./Menu.tsx";
import { openWorkbenchPanel } from "../lib/actions.ts";
import { isRemote } from "../lib/environment.ts";
import { useI18n } from "../lib/i18n.ts";
import { useApp } from "../lib/store.ts";

export function LinkActions() {
  const t = useI18n();
  const projectId = useApp(state => state.activeProjectId);
  const threadId = useApp(state => state.activeThreadId);
  const connected = useApp(state => state.connected);
  const sequence = useRef(0);
  const [link, setLink] = useState<{ anchor: HTMLAnchorElement; url: URL; id: number }>();

  useEffect(() => {
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor || anchor.hasAttribute("download")) return;
      let url: URL;
      try { url = new URL(anchor.href); } catch { return; }
      if (!["http:", "https:"].includes(url.protocol) || url.origin === location.origin) return;
      event.preventDefault();
      setLink({ anchor, url, id: ++sequence.current });
    };
    document.addEventListener("click", click);
    return () => document.removeEventListener("click", click);
  }, []);

  useEffect(() => setLink(undefined), [projectId, threadId]);
  if (!link) return null;
  const browserHint = !window.citropyDesktop ? t("Available in the desktop app") : isRemote() ? t("Available in a local workspace") : !projectId ? t("Open a workspace first.") : !connected ? t("Reconnect to continue.") : undefined;

  return <Menu
    key={link.id}
    anchor={link.anchor}
    header={link.url.hostname}
    width={300}
    className="link-actions-menu"
    controls={<div className="link-destination">{link.url.href}</div>}
    onClose={() => setLink(current => current?.id === link.id ? undefined : current)}
    items={[
      { id: "in-app", label: t("Open in Citropy"), hint: browserHint, disabled: Boolean(browserHint), icon: <Globe2 size={17} />, onSelect: () => {
        useApp.setState({ activeView: "chat", readingThreadId: null });
        openWorkbenchPanel("browser", link.url.href);
      } },
      { id: "external", label: t("Open in external browser"), icon: <ExternalLink size={17} />, onSelect: () => window.open(link.url.href, "_blank", "noopener,noreferrer") },
    ]}
  />;
}
