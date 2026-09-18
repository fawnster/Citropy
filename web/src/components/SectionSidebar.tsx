import { SelectionHighlight } from "./SelectionHighlight.tsx";
import { useI18n } from "../lib/i18n.ts";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { SlidingPanel } from "./SlidingPanel.tsx";
import { ResizeHandle } from "./ResizeHandle.tsx";

export function SectionSidebar({
  title,
  activeItem,
  open,
  onBack,
  children,
  navigation,
}: {
  title: string;
  activeItem: string;
  open: boolean;
  onBack: () => void;
  children: ReactNode;
  navigation?: ReactNode;
}) {
  const t = useI18n();
  return (
    <SlidingPanel open={open} side="left"><aside className="rail section-rail" aria-label={t(title)}>
      <div className="section-rail-heading">{t(title)}</div>
      <nav className="section-nav scroll sliding-selection" aria-label={t("{title} sections", { title: t(title) })}>
        <SelectionHighlight value={activeItem} />
        {children}
      </nav>
      <div className="section-back">
        <button className="rail-action" type="button" onClick={onBack}>
          <ArrowLeft size={16} />{t("Back to chat")}</button>
      </div>
      {navigation}
      <ResizeHandle panel="sidebar" />
    </aside></SlidingPanel>
  );
}
