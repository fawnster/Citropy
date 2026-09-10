import { useEffect, useState } from "react";
import { BarChart3, RefreshCw } from "lucide-react";
import { api } from "../lib/api.ts";
import { tokens, cost, providerLabels } from "../lib/format.ts";
import { ProviderIcon } from "./ProviderIcon.tsx";
import { SectionSidebar } from "./SectionSidebar.tsx";
import type { UsageReport } from "../../../shared/features.ts";

export function UsageView({
  sidebarOpen,
  onBack,
}: {
  sidebarOpen: boolean;
  onBack: () => void;
}) {
  const [data, setData] = useState<UsageReport>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [provider, setProvider] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError("");
    api<UsageReport>("usage", { signal: controller.signal })
      .then(setData)
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [revision]);
  return (
    <section className="section-view" aria-label="Usage">
      {sidebarOpen && (
        <SectionSidebar title="Usage" onBack={onBack}>
          <button className="section-link" aria-current="page">
            <BarChart3 size={17} />
            <span>Overview</span>
          </button>
        </SectionSidebar>
      )}
      <div className="settings scroll">
        <div className="settings-inner usage-inner">
          <header className="settings-heading">
            <div>
              <h1>Usage</h1>
              <p>Account allowance and tokens used in Citropy.</p>
            </div>
            <button
              className="btn"
              disabled={busy}
              onClick={() => setRevision((value) => value + 1)}
            >
              <RefreshCw size={15} className={busy ? "spin" : ""} />
              Refresh
            </button>
          </header>
          {error && (
            <p className="feature-error" role="alert">
              {error}
            </p>
          )}
          {!data && !error ? (
            <div className="pane-empty" role="status">
              Reading provider usage…
            </div>
          ) : (
            data && (
              <div className="feature-stack">
                <section>
                  <h2 className="settings-group-heading">
                    Remaining allowance
                  </h2>
                  <div className="allowance-grid">
                    {data.providers.map((entry) => (
                      <article className="allowance" key={entry.provider}>
                        <h3>
                          <ProviderIcon provider={entry.provider} />
                          {providerLabels[entry.provider]}
                        </h3>
                        {entry.windows.map((window) => (
                          <div className="allowance-window" key={window.label}>
                            <div>
                              <span>{window.label}</span>
                              <strong>
                                {Math.max(0, 100 - window.usedPercent).toFixed(
                                  0,
                                )}
                                % left
                              </strong>
                            </div>
                            <progress
                              value={Math.max(0, 100 - window.usedPercent)}
                              max={100}
                              aria-label={`${window.label} remaining`}
                            />
                            <small>
                              {window.resetsAt
                                ? `Resets ${new Date(window.resetsAt).toLocaleString()}`
                                : "Reset time not reported"}
                            </small>
                          </div>
                        ))}
                        {entry.error && (
                          <p className="feature-note">{entry.error}</p>
                        )}
                        <small>
                          Checked{" "}
                          {new Date(entry.updatedAt).toLocaleTimeString()}
                        </small>
                      </article>
                    ))}
                  </div>
                  <p className="feature-note">
                    Allowance is shared with other apps using the same account.
                    Tokens below cover saved Citropy conversations.
                  </p>
                </section>
                <div className="metric-grid usage-metrics">
                  <div>
                    <span>Input tokens</span>
                    <strong>{tokens(data.totals.input)}</strong>
                  </div>
                  <div>
                    <span>Output tokens</span>
                    <strong>{tokens(data.totals.output)}</strong>
                  </div>
                  <div>
                    <span>Cache read / write</span>
                    <strong>
                      {tokens(data.totals.cacheRead)} /{" "}
                      {tokens(data.totals.cacheWrite)}
                    </strong>
                  </div>
                  <div>
                    <span>Reported cost</span>
                    <strong>
                      {data.totals.costUsd
                        ? cost(data.totals.costUsd)
                        : "Not reported"}
                    </strong>
                  </div>
                </div>
                <section>
                  <div className="feature-section-heading">
                    <h2>Conversation usage</h2>
                    <select
                      aria-label="Filter usage by provider"
                      value={provider}
                      onChange={(event) => setProvider(event.target.value)}
                    >
                      <option value="">All providers</option>
                      <option value="claude">Claude Code</option>
                      <option value="codex">Codex</option>
                      <option value="opencode">OpenCode</option>
                    </select>
                  </div>
                  <div className="feature-table-wrap scroll">
                    <table className="feature-table">
                      <thead>
                        <tr>
                          <th>Conversation</th>
                          <th>Input</th>
                          <th>Output</th>
                          <th>Cache read</th>
                          <th>Cache write</th>
                          <th>Cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.conversations
                          .filter(
                            (thread) =>
                              !provider || thread.provider === provider,
                          )
                          .map((thread) => (
                            <tr key={thread.id}>
                              <td>
                                <strong className="truncate">
                                  {thread.title}
                                </strong>
                                <small>
                                  {providerLabels[thread.provider]} ·{" "}
                                  {thread.model || "Model not reported"}
                                </small>
                              </td>
                              <td>
                                {tokens(
                                  thread.usage.input +
                                    (thread.provider === "codex"
                                      ? 0
                                      : thread.usage.cacheRead +
                                        thread.usage.cacheWrite),
                                )}
                              </td>
                              <td>{tokens(thread.usage.output)}</td>
                              <td>{tokens(thread.usage.cacheRead)}</td>
                              <td>{tokens(thread.usage.cacheWrite)}</td>
                              <td>
                                {thread.usage.costUsd
                                  ? cost(thread.usage.costUsd)
                                  : "—"}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>
            )
          )}
        </div>
      </div>
    </section>
  );
}
