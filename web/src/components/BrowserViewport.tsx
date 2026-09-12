import { useEffect, useId, useState } from "react";
import {
  ChevronDown,
  Monitor,
  Smartphone,
  Tablet,
  SlidersHorizontal,
  RotateCw,
} from "lucide-react";
import { Menu } from "./Menu.tsx";
import type { BrowserAction, BrowserState } from "../../../shared/workbench.ts";
import { useI18n } from "../lib/i18n.ts";

const presets = [
  { id: "desktop", label: "Desktop", width: 1920, height: 1080, mobile: false, Icon: Monitor },
  { id: "laptop", label: "Laptop", width: 1440, height: 900, mobile: false, Icon: Monitor },
  { id: "tablet", label: "Tablet", width: 768, height: 1024, mobile: true, Icon: Tablet },
  { id: "phone", label: "Phone", width: 390, height: 844, mobile: true, Icon: Smartphone },
];

interface Props {
  state: BrowserState;
  disabled: boolean;
  onResize: (action: Extract<BrowserAction, { action: "resize" }>) => void;
}

export function BrowserViewport({ state, disabled, onResize }: Props) {
  const t = useI18n();
  const modeHint = useId();
  const [custom, setCustom] = useState(false);
  const [width, setWidth] = useState(String(state.width));
  const [height, setHeight] = useState(String(state.height));
  const selected = presets.find(
    (preset) =>
      preset.width === state.width &&
      preset.height === state.height &&
      preset.mobile === Boolean(state.mobile),
  );
  const Icon = selected?.Icon ?? (state.mobile ? Smartphone : Monitor);
  const valid =
    Number.isInteger(Number(width)) && Number(width) >= 320 && Number(width) <= 3840 &&
    Number.isInteger(Number(height)) && Number(height) >= 240 && Number(height) <= 2160;

  useEffect(() => {
    setWidth(String(state.width));
    setHeight(String(state.height));
  }, [state.width, state.height]);

  return (
    <div className="browser-viewport">
      <div className="browser-viewport-bar">
        <Menu
          header={t("Page resolution")}
          width={244}
          trigger={({ id, open, toggle }) => (
            <button
              id={id}
              type="button"
              className="browser-viewport-trigger"
              aria-label={t("Page resolution")}
              aria-haspopup="menu"
              aria-expanded={open}
              disabled={disabled}
              onClick={toggle}
            >
              <Icon size={14} className={`browser-device-${selected?.id ?? "custom"}`} />
              <span>{selected ? t(selected.label) : t("Custom")}</span>
              <span className="browser-viewport-size">{state.width} × {state.height}</span>
              <ChevronDown size={12} />
            </button>
          )}
          items={[
            ...presets.map(({ id, label, width, height, mobile, Icon }) => ({
              id,
              label: t(label),
              hint: `${width} × ${height}`,
              icon: <Icon size={16} className={`browser-device-${id}`} />,
              selected: selected?.id === id,
              onSelect: () => {
                setCustom(false);
                onResize({ action: "resize", width, height, mobile });
              },
            })),
            {
              id: "custom",
              label: t("Custom size"),
              hint: t("Set the page width and height"),
              icon: <SlidersHorizontal size={16} className="browser-device-custom" />,
              selected: !selected,
              onSelect: () => {
                setWidth(String(state.width));
                setHeight(String(state.height));
                setCustom(true);
              },
            },
          ]}
        />
        <button
          type="button"
          className="icon-btn"
          aria-label={t("Rotate page viewport")}
          title={t("Rotate viewport")}
          disabled={disabled || state.height < 320 || state.width > 2160}
          onClick={() => onResize({
            action: "resize",
            width: state.height,
            height: state.width,
            mobile: state.mobile,
          })}
        >
          <RotateCw size={13} />
        </button>
      </div>
      <label className="browser-mode">
        <Smartphone size={15} className="browser-device-phone" />
        <span>
          <span>{t("Mobile mode")}</span>
          <small id={modeHint}>{t("Mobile sites and touch. Reloads when changed.")}</small>
        </span>
        <input
          className="setting-switch"
          type="checkbox"
          role="switch"
          aria-label={t("Mobile mode")}
          aria-describedby={modeHint}
          checked={Boolean(state.mobile)}
          disabled={disabled || Boolean(state.dialog)}
          onChange={(event) => onResize({
            action: "resize",
            width: state.width,
            height: state.height,
            mobile: event.target.checked,
          })}
        />
      </label>
      {custom && (
        <form
          className="browser-viewport-custom"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid || disabled) return;
            onResize({ action: "resize", width: Number(width), height: Number(height), mobile: state.mobile });
            setCustom(false);
          }}
        >
          <div className="browser-viewport-fields">
            <label>
              {t("Width")}
              <input
                type="number"
                min={320}
                max={3840}
                step={1}
                required
                value={width}
                onChange={(event) => setWidth(event.target.value)}
                autoFocus
              />
            </label>
            <span aria-hidden="true">×</span>
            <label>
              {t("Height")}
              <input
                type="number"
                min={240}
                max={2160}
                step={1}
                required
                value={height}
                onChange={(event) => setHeight(event.target.value)}
              />
            </label>
            <span>px</span>
          </div>
          <div className="browser-viewport-actions">
            <button type="button" className="btn" onClick={() => setCustom(false)}>
              {t("Cancel")}
            </button>
            <button type="submit" className="btn primary" disabled={disabled || !valid}>
              {t("Apply size")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
