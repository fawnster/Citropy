import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { ResizeHandle } from "./ResizeHandle.tsx";

export function SectionSidebar({
  title,
  onBack,
  children,
  navigation,
}: {
  title: string;
  onBack: () => void;
  children: ReactNode;
  navigation?: ReactNode;
}) {
  return (
    <aside className="rail section-rail" aria-label={title}>
      <div className="section-rail-heading">{title}</div>
      <nav className="section-nav scroll" aria-label={`${title} sections`}>
        {children}
      </nav>
      <div className="section-back">
        <button className="rail-action" type="button" onClick={onBack}>
          <ArrowLeft size={16} />
          Back to chat
        </button>
      </div>
      {navigation}
      <ResizeHandle panel="sidebar" />
    </aside>
  );
}
