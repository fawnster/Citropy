import { useApp } from "./store.ts";
import { translateFor, type Translator } from "./translations.ts";

const translators: Record<"en" | "es", Translator> = {
  en: (message, values, context) => translateFor("en", message, values, context),
  es: (message, values, context) => translateFor("es", message, values, context),
};

export function useI18n(): Translator {
  const language = useApp((state) => state.language);
  return translators[language];
}

export const translate: Translator = (message, values, context) =>
  translators[useApp.getState().language](message, values, context);

export function currentLocale(): string {
  return useApp.getState().language === "es" ? "es-ES" : "en-US";
}
