import { useEffect, useState } from "react";

export function ChannelBadge() {
  const [channel, setChannel] = useState<"stable" | "lemon">("stable");
  useEffect(() => {
    let alive = true;
    void window.citropyDesktop
      ?.windowState?.()
      .then((state) => {
        if (alive) setChannel(state.channel ?? "stable");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  if (channel !== "lemon") return null;
  return (
    <span className="channel-badge" title="Rolling build from main">
      Lemon
    </span>
  );
}
