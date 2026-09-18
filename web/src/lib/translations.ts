import { automationEs } from "./locales/automation.es.ts";
import { environmentsEs } from "./locales/environments.es.ts";
import { coreEs } from "./locales/core.es.ts";
import { settingsEs } from "./locales/settings.es.ts";
import { chatEs } from "./locales/chat.es.ts";
import { gitEs } from "./locales/git.es.ts";
import { systemEs } from "./locales/system.es.ts";

export type Language = "en" | "es";
export type TranslationValues = Record<string, string | number>;
export type Translator = (message: string, values?: TranslationValues, context?: string) => string;

export const spanish: Record<string, string> = {
  ...coreEs,
  ...automationEs,
  ...environmentsEs,
  ...settingsEs,
  ...chatEs,
  ...gitEs,
  ...systemEs,
};

export function translateFor(language: Language, message: string, values?: TranslationValues, context?: string): string {
  const key = context ? `${context}:${message}` : message;
  const translated = language !== "es" ? message
    : Object.hasOwn(spanish, key) ? spanish[key]!
    : Object.hasOwn(spanish, message) ? spanish[message]!
    : message;
  return translated.replace(/\{(\w+)\}/g, (match, key: string) =>
    values && Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}
