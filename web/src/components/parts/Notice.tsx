import { AlertTriangle } from "../icons.ts";
import { Info } from "lucide-react";

interface Props {
  level: "info" | "warn" | "error";
  text: string;
}

export function Notice({ level, text }: Props) {
  return (
    <div className="notice" data-level={level}>
      {level === "info" ? <Info size={15} /> : <AlertTriangle size={13} />}
      <span className={level === "info" ? undefined : "mono"}>{text}</span>
    </div>
  );
}
