import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="git-empty">
      <Icon size={34} strokeWidth={1.3} />
      <h2>{title}</h2>
      <div className="git-empty-copy">{children}</div>
      {action && <div className="git-empty-action">{action}</div>}
    </div>
  );
}
