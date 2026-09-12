import { valid } from "semver";
import { store } from "./store.ts";

const notified = new Map<string, string>();

export function notifyUpdateAvailable(name: string, version: string, section: "Providers" | "Application"): void {
  if (!valid(version) || notified.get(name) === version) return;
  const key = `update:${name}:${version}`;
  notified.set(name, version);
  if (store.notifications.some((entry) => entry.dedupeKey === key)) return;
  store.notify({
    title: "Update available",
    text: `${name} ${version}`,
    kind: "update",
    level: "info",
    dedupeKey: key,
    target: { view: "settings", section },
  });
}
