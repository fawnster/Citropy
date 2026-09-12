import type { ProviderId } from "./protocol.ts";

export interface ProviderMaintenance {
  provider: ProviderId;
  status: "idle" | "updating" | "success" | "error";
  available: boolean;
  updateStatus?: "available" | "current" | "unknown";
  latestVersion?: string;
  checkedAt?: number;
  version?: string;
  binaryPath?: string;
  method?: string;
  command?: string;
  reason?: string;
  message?: string;
  output?: string;
}

export interface GlobalInstructions {
  provider: ProviderId;
  path: string;
  exists: boolean;
  content: string;
  revision: string;
  note?: string;
}
