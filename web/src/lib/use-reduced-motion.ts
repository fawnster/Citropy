import { useSyncExternalStore } from "react";

const preference = typeof window === "undefined" ? null : window.matchMedia("(prefers-reduced-motion: reduce)");
const subscribe = (update: () => void) => {
  preference?.addEventListener("change", update);
  return () => preference?.removeEventListener("change", update);
};
const snapshot = () => preference?.matches ?? true;

export function useReducedMotion() {
  return useSyncExternalStore(subscribe, snapshot, () => true);
}
