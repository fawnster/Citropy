import { SelectionHighlight } from "./SelectionHighlight.tsx";
import { AnimatedText } from "./AnimatedText.tsx";
import { useEffect, useState, type Ref } from "react";
import { ArrowRightLeft, ChevronDown, LockKeyhole, Star } from "lucide-react";
import type { WritingModel } from "../../../shared/assistance.ts";
import type { ProviderId } from "../../../shared/protocol.ts";
import { selectedModel } from "../../../shared/model-options.ts";
import { toggleFavoriteModel, useApp } from "../lib/store.ts";
import { useI18n } from "../lib/i18n.ts";
import { modelLabel, modelSource } from "../lib/format.ts";
import { send } from "../lib/socket.ts";
import { Menu } from "./Menu.tsx";
import { ProviderIcon } from "./ProviderIcon.tsx";

export function ModelPicker({ value, fallback, label, onChange, onTransfer, transferDisabled = false, disabled = false, allowConversation = false, automaticLabel, lockedProvider, className = "model-picker-trigger", buttonRef }: {
  value: WritingModel | null;
  fallback?: WritingModel;
  label: string;
  onChange: (value: WritingModel | null) => void;
  onTransfer?: (value: WritingModel) => void;
  transferDisabled?: boolean;
  disabled?: boolean;
  allowConversation?: boolean;
  automaticLabel?: string;
  lockedProvider?: ProviderId;
  className?: string;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  const t = useI18n();
  const providers = useApp((state) => state.providers);
  const favorites = useApp((state) => state.favoriteModels);
  const choice = value ?? fallback;
  const [browsing, setBrowsing] = useState<ProviderId | "favorites" | undefined>(choice?.provider);
  const [transferring, setTransferring] = useState(false);
  useEffect(() => setBrowsing(choice?.provider), [choice?.provider]);
  const available = providers.filter((entry) => entry.available && entry.enabled);
  const provider = providers.find((entry) => entry.id === choice?.provider);
  const locked = transferring ? undefined : lockedProvider;
  const catalog = locked ? providers.find((entry) => entry.id === locked) : available.find((entry) => entry.id === browsing) ?? available[0];
  const model = selectedModel(provider?.models ?? [], choice?.model);
  const automatic = automaticLabel ?? (allowConversation ? t("Use the conversation model") : undefined);
  const name = !choice && automatic ? automatic : modelLabel(provider?.models ?? [], choice?.model);
  const favoritesView = browsing === "favorites";
  const catalogs = favoritesView ? available.filter((entry) => !locked || entry.id === locked) : catalog ? [catalog] : [];
  return <Menu
    width={340}
    className="model-picker-menu"
    searchable
    emptyMessage={favoritesView ? t("Star models to find them here.") : undefined}
    controls={<>
      {onTransfer && <>
        <button className="model-picker-transfer" type="button" aria-pressed={transferring} disabled={transferDisabled} onClick={() => { setTransferring(!transferring); setBrowsing(choice?.provider); }}>
          <ArrowRightLeft size={15} />{t("Transfer to another agent")}
        </button>
        {transferring && <p className="model-picker-note" role="status">{t("Choose a model for a new agent in this chat. Reading the conversation again consumes extra usage.")}</p>}
      </>}
      <div className="model-picker-toolbar sliding-selection">
        <SelectionHighlight value={favoritesView ? "favorites" : catalog?.id} />
        {locked && catalog ? <button className="model-picker-locked" type="button" aria-label={`${catalog.label} · ${t("Provider locked")}`} title={`${catalog.label} · ${t("Provider locked")}`} aria-pressed={!favoritesView} onClick={() => setBrowsing(catalog.id)}>
          <ProviderIcon provider={catalog.id} /><LockKeyhole size={11} />
        </button> : <div className="model-picker-providers" role="group" aria-label={`${label} · ${t("Provider")}`}>
          {available.map((entry) => <button key={entry.id} type="button" aria-label={entry.label} title={entry.label} aria-pressed={!favoritesView && catalog?.id === entry.id} onClick={() => setBrowsing(entry.id)}>
            <ProviderIcon provider={entry.id} />
          </button>)}
        </div>}
        <button className="model-picker-favorites" type="button" aria-label={t("Favorite models")} title={t("Favorite models")} aria-pressed={favoritesView} onClick={() => setBrowsing(favoritesView ? choice?.provider : "favorites")}><Star size={17} fill={favoritesView ? "currentColor" : "none"} /></button>
      </div>
      {catalog?.modelsError && <p className="model-picker-note" role="status">{t("Models · refresh unavailable")}</p>}
    </>}
    items={[
      ...(automatic && !favoritesView && !transferring ? [{ id: "conversation", label: automatic, selected: !value, onSelect: () => onChange(null) }] : []),
      ...catalogs.flatMap((source) => source.models.filter((entry) => !favoritesView || favorites.some((favorite) => favorite.provider === source.id && favorite.model === entry.id)).map((entry) => ({
        id: `${source.id}:${entry.id}`,
        label: entry.label,
        hint: modelSource(source, entry),
        hintIcon: <ProviderIcon provider={source.id} />,
        disabled: !source.available || !source.enabled || (transferring && (transferDisabled || (source.id === choice?.provider && entry.id === model?.id))),
        selected: Boolean(value && source.id === choice?.provider && entry.id === model?.id),
        onSelect: () => transferring ? onTransfer?.({ provider: source.id, model: entry.id }) : onChange({ provider: source.id, model: entry.id }),
        action: {
          label: t("Favorite {model}", { model: entry.label }),
          icon: <Star size={14} />,
          pressed: favorites.some((favorite) => favorite.provider === source.id && favorite.model === entry.id),
          onSelect: () => toggleFavoriteModel({ provider: source.id, model: entry.id }),
        },
      }))),
    ]}
    trigger={({ toggle, id, open }) => <button
      ref={buttonRef}
      id={id}
      type="button"
      className={className}
      aria-label={`${label}: ${name}`}
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={disabled}
      onClick={() => { if (!open) { setBrowsing(choice?.provider); setTransferring(false); send({ t: "providers.refresh" }); } toggle(); }}
    >
      {choice && <ProviderIcon provider={choice.provider} />}
      <AnimatedText className="truncate" text={name} />
      <ChevronDown size={12} />
    </button>}
  />;
}
