import { useI18n } from "../lib/i18n.ts";
import { useState } from "react";
import { Plug, Search, Check, Circle } from "lucide-react";
import { useApp } from "../lib/store.ts";

export function ToolsPane() {
  const t = useI18n();
  const tools = useApp((state) => state.tools);
  const threadId = useApp((state) => state.activeThreadId);
  const connection = useApp((state) =>
    threadId ? state.toolConnections[threadId] : undefined,
  );
  const connected = useApp((state) => state.connected);
  const [query, setQuery] = useState("");
  const ready = connected && connection?.connected;
  return (
    <div className="tools-pane scroll">
      <div className="panel-section-heading">
        <Plug size={19} className="panel-icon-tools" />
        <div>
          <h3>{t("Citropy tools")}</h3>
          <p>Model Context Protocol</p>
        </div>
        <span className="tools-status" data-ready={ready}>
          {ready ? <Check size={13} /> : <Circle size={11} />}
          {ready ? t("Connected") : t("Ready to connect")}
        </span>
      </div>
      <p className="tools-explainer">
        {ready
          ? t("Your provider can use these tools in this workspace. Actions follow the conversation's permission setting.")
          : t("Tools connect when a provider starts its next turn. Browser and terminal tabs are shared with you.")}
      </p>
      <label className="tools-search">
        <Search size={14} />
        <input
          aria-label={t("Find a tool")}
          placeholder={t("Find a tool…")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="tools-list">
        {tools
          .filter((tool) =>
            `${tool.name} ${t(tool.description)}`
              .toLowerCase()
              .includes(query.toLowerCase()),
          )
          .map((tool) => (
            <details key={tool.name} className="tool-definition">
              <summary>
                <span>{tool.name.replaceAll("_", " ")}</span>
                {tool.annotations?.readOnlyHint && <small>{t("Read")}</small>}
              </summary>
              <p>{t(tool.description)}</p>
            </details>
          ))}
      </div>
    </div>
  );
}
