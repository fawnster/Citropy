import { memo } from "react";
import { Prose } from "./parts/Prose.tsx";
import { Reasoning } from "./parts/Reasoning.tsx";
import { ToolCard } from "./parts/ToolCard.tsx";
import { TodoBoard } from "./parts/TodoBoard.tsx";
import { Notice } from "./parts/Notice.tsx";
import { useApp } from "../lib/store.ts";

interface Props {
  partId: string;
  live: boolean;
}

export const PartView = memo(function PartView({ partId, live }: Props) {
  const part = useApp((state) => state.parts[partId]);
  if (!part) return null;

  switch (part.kind) {
    case "text":
      return <Prose partId={part.id} text={part.text} live={live && part.complete !== true} />;
    case "reasoning":
      return <Reasoning text={part.text} live={live && part.complete !== true} />;
    case "tool":
      return <ToolCard part={part} />;
    case "todo":
      return <TodoBoard items={part.items} />;
    case "notice":
      return <Notice level={part.level} text={part.text} />;
    default:
      return null;
  }
});
