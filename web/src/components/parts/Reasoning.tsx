import { useApp } from "../../lib/store.ts";

interface Props {
  text: string;
  live: boolean;
}

export function Reasoning({ text, live }: Props) {
  const streaming = useApp((state) => state.textStreaming);
  if (!text.trim() || (!streaming && live)) return null;

  return <div className="reason-text">{text}</div>;
}
