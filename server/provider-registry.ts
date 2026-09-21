import { bus } from "./bus.ts";
import { describeProviders } from "./providers/index.ts";
import { store } from "./store.ts";
import type { ProviderInfo } from "../shared/protocol.ts";

const THROTTLE = 30_000;

let info: ProviderInfo[] = [];
let refreshing: Promise<void> | null = null;
let lastRefresh = 0;

function withEnabled(providers: ProviderInfo[]): ProviderInfo[] {
  return providers.map((provider) => ({ ...provider, enabled: !store.disabledProviders.has(provider.id) }));
}

export function providerInfo(): ProviderInfo[] {
  return info;
}

export function refreshProviders(force = false): Promise<void> {
  if (refreshing) return force ? refreshing.then(() => refreshProviders(true)) : refreshing;
  if (!force && Date.now() - lastRefresh < THROTTLE) return Promise.resolve();
  refreshing = describeProviders()
    .then((described) => {
      info = withEnabled(described);
      lastRefresh = Date.now();
      bus.emit({ t: "providers.update", providers: info });
    })
    .catch((error) => {
      process.stderr.write(`Could not refresh providers: ${(error as Error).message}\n`);
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export function publishProviderStatus(): void {
  info = withEnabled(info);
  bus.emit({ t: "providers.update", providers: info });
}

export async function refreshProvidersNow(): Promise<void> {
  if (refreshing) await refreshing;
  lastRefresh = 0;
  await refreshProviders();
}
