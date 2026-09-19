import claude from "../assets/providers/claude-light.svg";
import codexLight from "../assets/providers/chatgpt-light.svg";
import codexDark from "../assets/providers/chatgpt-dark.svg";
import cursorLight from "../assets/providers/cursor-light.svg";
import cursorDark from "../assets/providers/cursor-dark.svg";
import opencodeLight from "../assets/providers/opencode-light.svg";
import opencodeDark from "../assets/providers/opencode-dark.svg";
import { useApp } from "../lib/store.ts";
import type { ProviderId } from "../../../shared/protocol.ts";

const logos = {
  claude: { light: claude, dark: claude },
  codex: { light: codexLight, dark: codexDark },
  cursor: { light: cursorLight, dark: cursorDark },
  opencode: { light: opencodeLight, dark: opencodeDark },
};

export function ProviderIcon({ provider }: { provider: ProviderId }) {
  const theme = useApp((state) => state.theme);
  return (
    <img
      className="provider-icon"
      data-provider={provider}
      src={logos[provider][theme]}
      width={20}
      height={20}
      alt=""
      aria-hidden="true"
      style={{ flexShrink: 0, objectFit: "contain" }}
    />
  );
}
