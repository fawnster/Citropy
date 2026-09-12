import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { useApp } from "../lib/store.ts";
import { useI18n } from "../lib/i18n.ts";
import type { AssistanceSettings as Preferences } from "../../../shared/assistance.ts";

export function AssistanceSettings() {
  const t = useI18n();
  const settings = useApp((state) => state.assistance);
  const providers = useApp((state) => state.providers);
  const connected = useApp((state) => state.connected);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState(settings);
  useEffect(() => { if (!saving) setDraft(settings); }, [settings, saving]);
  const save = async (patch: Partial<Preferences>) => {
    setSaving(true);
    setError("");
    setDraft((previous) => ({ ...previous, ...patch }));
    try {
      const assistance = await api<Preferences>("providers/assistance", { method: "PATCH", body: JSON.stringify(patch) });
      useApp.setState({ assistance });
    } catch (error) { setError((error as Error).message); }
    finally { setSaving(false); }
  };
  const selector = (key: "commitModel" | "titleModel", label: string) => {
    const chosen = draft[key];
    const value = chosen ? JSON.stringify(chosen) : "";
    const available = providers.filter((provider) => provider.available && provider.enabled);
    const missing = chosen && !available.some((provider) => provider.id === chosen.provider && provider.models.some((model) => model.id === chosen.model));
    return <select aria-label={label} value={value} disabled={!connected || saving} onChange={(event) => void save({ [key]: event.target.value ? JSON.parse(event.target.value) : null })}>
      <option value="">{t("Use the conversation model")}</option>
      {missing && <option value={value} disabled>{t("Unavailable model: {model}", { model: chosen.model })}</option>}
      {available.map((provider) => <optgroup key={provider.id} label={provider.label}>
        {provider.models.map((model) => <option key={model.id} value={JSON.stringify({ provider: provider.id, model: model.id })}>{model.label}</option>)}
      </optgroup>)}
    </select>;
  };
  return <>
    <h2 className="settings-group-heading">{t("Conversation titles")}</h2>
    <div className="settings-group">
      <label className="setting-row">
        <span><strong>{t("Automatic titles")}</strong><small>{t("Name new conversations from your first message. Renaming a conversation keeps your chosen title.")}</small></span>
        <input type="checkbox" role="switch" className="setting-switch" checked={draft.automaticTitles} disabled={!connected || saving} onChange={(event) => void save({ automaticTitles: event.target.checked })} />
      </label>
      <label className="setting-row assistance-model-row">
        <span><strong>{t("Title model")}</strong><small>{t("Choose the model that names your conversations.")}</small></span>
        {selector("titleModel", t("Title model"))}
      </label>
    </div>
    <h2 className="settings-group-heading settings-group-spaced">{t("Commit messages")}</h2>
    <div className="settings-group">
      <label className="setting-row assistance-model-row">
        <span><strong>{t("Commit model")}</strong><small>{t("Write commit messages from the selected changes and recent commit subjects.")}</small></span>
        {selector("commitModel", t("Commit model"))}
      </label>
    </div>
    <p className="settings-note">{t("Titles and commit messages use separate requests on your provider accounts. Git actions run only when you click them in chat.")}</p>
    {error && <p className="feature-error" role="alert">{error}</p>}
  </>;
}
