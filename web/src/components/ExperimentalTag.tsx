import { useI18n } from "../lib/i18n.ts";

export function ExperimentalTag() {
  const t = useI18n();
  return <span className="experimental-tag">{t("Experimental")}</span>;
}
