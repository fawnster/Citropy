import type { ServerEvent } from "../shared/protocol.ts";

type Listener = (event: ServerEvent) => void;

export class Bus {
  #listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(event: ServerEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

export const bus = new Bus();
