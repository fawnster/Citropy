import { environmentStorage } from "./environment.ts";
import { useApp, type PanelId, type Theme } from "./app-state.ts";
import type { WritingModel } from "../../../shared/assistance.ts";
import type { Language } from "./translations.ts";

export function toggleFavoriteModel(model: WritingModel): void {
  const current = useApp.getState().favoriteModels;
  const exists = current.some((entry) => entry.provider === model.provider && entry.model === model.model);
  const favoriteModels = exists ? current.filter((entry) => entry.provider !== model.provider || entry.model !== model.model) : [...current, model];
  useApp.setState({ favoriteModels });
  environmentStorage.setItem("citropy.favoriteModels", JSON.stringify(favoriteModels));
}

export function setPanelWidth(panel: PanelId, width?: number): void {
  if (width !== undefined && (!Number.isFinite(width) || width <= 0)) return;
  const panelWidths = { ...useApp.getState().panelWidths };
  if (width === undefined) delete panelWidths[panel];
  else panelWidths[panel] = Math.round(width);
  useApp.setState({ panelWidths });
  environmentStorage.setItem("citropy.panelWidths", JSON.stringify(panelWidths));
}

export function setLanguage(language: Language): void {
  if (language !== "en" && language !== "es") return;
  useApp.setState({ language });
  environmentStorage.setItem("citropy.language", language);
}

export function setTheme(theme: Theme): void {
  useApp.setState({ theme });
  environmentStorage.setItem("citropy.theme", theme);
  document.documentElement.dataset.theme = theme;
}

export function toggleInspector(): void {
  const next = !useApp.getState().inspectorOpen;
  useApp.setState({ inspectorOpen: next });
  environmentStorage.setItem("citropy.inspector", next ? "1" : "0");
}

export function toggleSidebar(): void {
  const next = !useApp.getState().sidebarOpen;
  useApp.setState({ sidebarOpen: next });
  environmentStorage.setItem("citropy.sidebar", next ? "1" : "0");
}

export function setUiScale(value: number): void {
  const uiScale = Math.max(90, Math.min(150, Math.round(value)));
  if (!Number.isFinite(uiScale)) return;
  useApp.setState({ uiScale });
  environmentStorage.setItem("citropy.uiScale", String(uiScale));
  document.documentElement.style.setProperty(
    "--ui-scale",
    String(uiScale / 100),
  );
}

export function setTextStreaming(value: boolean): void {
  useApp.setState({ textStreaming: value });
  environmentStorage.setItem("citropy.textStreaming", value ? "1" : "0");
}

export function setShowGitHubIdentity(value: boolean): void {
  useApp.setState({ showGitHubIdentity: value });
  environmentStorage.setItem("citropy.showGitHubIdentity", value ? "1" : "0");
}

export function setTypingAnimation(value: boolean): void {
  useApp.setState({ typingAnimation: value });
  environmentStorage.setItem("citropy.typingAnimation", value ? "1" : "0");
}

export function setUiSounds(value: boolean): void {
  useApp.setState({ uiSounds: value });
  environmentStorage.setItem("citropy.uiSounds", value ? "1" : "0");
}

export function setUiAlertSounds(value: boolean): void {
  useApp.setState({ uiAlertSounds: value });
  environmentStorage.setItem("citropy.uiAlertSounds", value ? "1" : "0");
}

export function setUiSoundVolume(value: number): void {
  if (!Number.isFinite(value)) return;
  const uiSoundVolume = Math.max(0, Math.min(100, Math.round(value)));
  useApp.setState({ uiSoundVolume });
  environmentStorage.setItem("citropy.uiSoundVolume", String(uiSoundVolume));
}

export function setTypingSpeed(value: number): void {
  if (!Number.isFinite(value)) return;
  const typingSpeed = Math.max(20, Math.min(300, Math.round(value)));
  useApp.setState({ typingSpeed });
  environmentStorage.setItem("citropy.typingSpeed", String(typingSpeed));
}

export function scaled(value: number): number {
  return Math.round((value * useApp.getState().uiScale) / 100);
}

export function viewportWidth(): number {
  return window.innerWidth / (useApp.getState().uiScale / 100);
}
