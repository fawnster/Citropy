import { useI18n } from "../lib/i18n.ts";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { ResizeHandle } from "./ResizeHandle.tsx";

export function SectionSidebar({
  title,
  onBack,
  children,
  navigation,
  workspace,
}: {
  title: string;
  onBack: () => void;
  children: ReactNode;
  navigation?: ReactNode;
  workspace?: ReactNode;
}) {
  const t = useI18n();
  return (
    <aside className="rail section-rail" aria-label={t(title)}>
      {workspace ? <div className="rail-head">{workspace}</div> : <div className="section-rail-heading">{t(title)}</div>}
      <nav className="section-nav scroll" aria-label={t("{title} sections", { title: t(title) })}>
        {children}
      </nav>
      <div className="section-back">
        <button className="rail-action" type="button" onClick={onBack}>
          <ArrowLeft size={16} />{t("Back to chat")}</button>
      </div>
      {navigation}
      <ResizeHandle panel="sidebar" />
    </aside>
  );
}
