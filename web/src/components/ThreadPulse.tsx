import {
  CircleAlert,
  Clock3,
  LoaderCircle,
  Pause,
  MessageCircleQuestion,
} from "lucide-react";
import type { ThreadStatus } from "../../../shared/protocol.ts";

export function ThreadPulse({
  status,
  size = 13,
}: {
  status: ThreadStatus;
  size?: number;
}) {
  if (status === "idle") return null;
  const busy = status === "working" || status === "thinking";
  const Icon = busy
    ? LoaderCircle
    : status === "queued"
      ? Clock3
      : status === "error"
        ? CircleAlert
        : status === "awaiting"
          ? MessageCircleQuestion
          : Pause;
  return (
    <Icon
      size={size}
      className={busy ? "git-spinner" : undefined}
      aria-hidden="true"
    />
  );
}
