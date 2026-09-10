import type { Usage } from "../../shared/protocol.ts";

const keys = ["input", "output", "cacheRead", "cacheWrite", "costUsd"] as const;

export class MessageUsage {
  totals: Pick<Usage, (typeof keys)[number]>;
  #messages = new Map<string, Partial<Usage>>();

  constructor(initial?: Partial<Usage>) {
    this.totals = {
      input: initial?.input ?? 0,
      output: initial?.output ?? 0,
      cacheRead: initial?.cacheRead ?? 0,
      cacheWrite: initial?.cacheWrite ?? 0,
      costUsd: initial?.costUsd ?? 0,
    };
  }

  update(
    id: string,
    usage: Partial<Usage>,
  ): Pick<Usage, (typeof keys)[number]> {
    const previous = this.#messages.get(id) ?? {};
    const next = { ...previous };
    for (const key of keys) {
      const value = usage[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
        continue;
      this.totals[key] += value - (previous[key] ?? 0);
      next[key] = value;
    }
    this.#messages.set(id, next);
    if (this.#messages.size > 2048)
      this.#messages.delete(this.#messages.keys().next().value!);
    return { ...this.totals };
  }
}
