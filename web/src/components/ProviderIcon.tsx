import claude from "../assets/providers/claude-light.svg";
import codexLight from "../assets/providers/chatgpt-light.svg";
import codexDark from "../assets/providers/chatgpt-dark.svg";
import opencodeLight from "../assets/providers/opencode-light.svg";
import opencodeDark from "../assets/providers/opencode-dark.svg";
import { useApp } from "../lib/store.ts";
import type { ProviderId } from "../../../shared/protocol.ts";

const logos = {
  claude: { light: claude, dark: claude },
  codex: { light: codexLight, dark: codexDark },
  opencode: { light: opencodeLight, dark: opencodeDark },
};

export function ProviderIcon({ provider }: { provider: ProviderId }) {
  const theme = useApp((state) => state.theme);
  return (
    <img
      className="provider-icon"
      data-provider={provider}
      src={logos[provider][theme]}
      width={18}
      height={18}
      alt=""
      aria-hidden="true"
      style={{ flexShrink: 0, objectFit: "contain" }}
    />
  );
}
