import { useEffect, useState, type ReactNode } from "react";
import { BarChart3, RefreshCw } from "lucide-react";
import { api } from "../lib/api.ts";
import { tokens, cost, providerLabels } from "../lib/format.ts";
import { ProviderIcon } from "./ProviderIcon.tsx";
import { SectionSidebar } from "./SectionSidebar.tsx";
import type { UsageReport } from "../../../shared/features.ts";
import { currentLocale, useI18n } from "../lib/i18n.ts";

export function UsageView({
  sidebarOpen,
  onBack,
  navigation,
}: {
  sidebarOpen: boolean;
  onBack: () => void;
  navigation?: ReactNode;
}) {
  const t = useI18n();
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
    <section className="section-view" aria-label={t("Usage")}>
      <SectionSidebar activeItem="usage" open={sidebarOpen} title={t("Usage")} onBack={onBack} navigation={navigation}>
          <button className="section-link" aria-current="page">
            <BarChart3 size={17} />
            <span>{t("Overview")}</span>
          </button>
      </SectionSidebar>
      <div className="settings scroll">
        <div className="settings-inner usage-inner">
          <header className="settings-heading">
            <div>
            <h1>{t("Usage")}</h1>
            <p>{t("Account allowance and tokens used in Citropy.")}</p>
            </div>
            <button
              className="btn"
              disabled={busy}
              onClick={() => setRevision((value) => value + 1)}
            >
              <RefreshCw size={15} className={busy ? "spin" : ""} />
              {t("Refresh")}
            </button>
          </header>
          {error && (
            <p className="feature-error" role="alert">
              {error}
            </p>
          )}
          {!data && !error ? (
            <div className="pane-empty" role="status">
              {t("Reading provider usage…")}
            </div>
          ) : (
            data && (
              <div className="feature-stack">
                <section>
                  <h2 className="settings-group-heading">
                    {t("Remaining allowance")}
                  </h2>
                  <div className="allowance-grid">
                    {data.providers.map((entry) => (
                      <article className="allowance" key={entry.provider}>
                        <h3>
                          <ProviderIcon provider={entry.provider} />
                          {providerLabels[entry.provider]}
                        </h3>
                        {entry.windows.map((window) => {
                          const label = window.label.split(" · ").map((part) => {
                            const hours = /^(\d+(?:\.\d+)?) hours$/.exec(part);
                            return hours ? t("{hours} hours", { hours: hours[1]! }) : t(part);
                          }).join(" · ");
                          return (
                          <div className="allowance-window" key={window.label}>
                            <div>
                              <span>{label}</span>
                              <strong>
                                {Math.max(0, 100 - window.usedPercent).toFixed(
                                  0,
                                )}
                                {t("% left")}
                              </strong>
                            </div>
                            <progress
                              value={Math.max(0, 100 - window.usedPercent)}
                              max={100}
                              aria-label={t("{period} remaining", { period: label })}
                            />
                            <small>
                              {window.resetsAt
                                ? t("Resets {date}", { date: new Date(window.resetsAt).toLocaleString(currentLocale()) })
                                : t("Reset time not reported")}
                            </small>
                          </div>
                          );
                        })}
                        {entry.error && (
                          <p className="feature-note">{t(entry.error)}</p>
                        )}
                        <small>
                          {t("Checked")}{" "}
                          {new Date(entry.updatedAt).toLocaleTimeString(currentLocale())}
                        </small>
                      </article>
                    ))}
                  </div>
                  <p className="feature-note">
                    {t("Allowance is shared with other apps using the same account. Tokens below cover saved Citropy conversations.")}
                  </p>
                </section>
                <div className="metric-grid usage-metrics">
                  <div>
                    <span>{t("Input tokens")}</span>
                    <strong>{tokens(data.totals.input)}</strong>
                  </div>
                  <div>
                    <span>{t("Output tokens")}</span>
                    <strong>{tokens(data.totals.output)}</strong>
                  </div>
                  <div>
                    <span>{t("Cache read / write")}</span>
                    <strong>
                      {tokens(data.totals.cacheRead)} /{" "}
                      {tokens(data.totals.cacheWrite)}
                    </strong>
                  </div>
                  <div>
                    <span>{t("Reported cost")}</span>
                    <strong>
                      {data.totals.costUsd
                        ? cost(data.totals.costUsd)
                        : t("Not reported")}
                    </strong>
                  </div>
                </div>
                <section>
                  <div className="feature-section-heading">
                    <h2>{t("Conversation usage")}</h2>
                    <select
                      aria-label={t("Filter usage by provider")}
                      value={provider}
                      onChange={(event) => setProvider(event.target.value)}
                    >
                      <option value="">{t("All providers")}</option>
                      <option value="claude">Claude Code</option>
                      <option value="codex">Codex</option>
                      <option value="opencode">OpenCode</option>
                    </select>
                  </div>
                  <div className="feature-table-wrap scroll">
                    <table className="feature-table">
                      <thead>
                        <tr>
                          <th>{t("Conversation")}</th>
                          <th>{t("Input")}</th>
                          <th>{t("Output")}</th>
                          <th>{t("Cache read")}</th>
                          <th>{t("Cache write")}</th>
                          <th>{t("Cost")}</th>
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
                                  {thread.model || t("Model not reported")}
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
