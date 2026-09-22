import { AlertTriangle } from "../icons.ts";
import { Info } from "lucide-react";
import { Prose } from "./Prose.tsx";

interface Props {
  level: "info" | "warn" | "error";
  text: string;
}

export function Notice({ level, text }: Props) {
  return (
    <div className="notice" data-level={level}>
      {level === "info" ? <Info size={15} /> : <AlertTriangle size={13} />}
      <Prose text={text} live={false} images={false} />
    </div>
  );
}
