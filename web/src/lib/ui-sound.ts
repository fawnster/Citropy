export type UiSound =
  | "click"
  | "nav"
  | "toggle-on"
  | "toggle-off"
  | "send"
  | "copy"
  | "done"
  | "attention"
  | "error";

interface Recipe {
  asset: string;
  gain: number;
  alert: boolean;
}

const sounds: Record<UiSound, Recipe> = {
  click: {
    asset: new URL("../assets/sounds/click.ogg", import.meta.url).href,
    gain: 0.9,
    alert: false,
  },
  nav: {
    asset: new URL("../assets/sounds/nav.ogg", import.meta.url).href,
    gain: 0.85,
    alert: false,
  },
  "toggle-on": {
    asset: new URL("../assets/sounds/toggle-on.ogg", import.meta.url).href,
    gain: 0.9,
    alert: false,
  },
  "toggle-off": {
    asset: new URL("../assets/sounds/toggle-off.ogg", import.meta.url).href,
    gain: 0.9,
    alert: false,
  },
  send: {
    asset: new URL("../assets/sounds/send.ogg", import.meta.url).href,
    gain: 0.9,
    alert: false,
  },
  copy: {
    asset: new URL("../assets/sounds/copy.ogg", import.meta.url).href,
    gain: 0.9,
    alert: false,
  },
  done: {
    asset: new URL("../assets/sounds/done.ogg", import.meta.url).href,
    gain: 0.85,
    alert: true,
  },
  attention: {
    asset: new URL("../assets/sounds/attention.ogg", import.meta.url).href,
    gain: 0.9,
    alert: true,
  },
  error: {
    asset: new URL("../assets/sounds/error.ogg", import.meta.url).href,
    gain: 0.9,
    alert: true,
  },
};

const names = Object.keys(sounds) as UiSound[];
const loaded = new Map<UiSound, AudioBuffer>();
const loading = new Map<UiSound, Promise<unknown>>();

let volume = 60;
let interfaceSounds = true;
let alertSounds = true;
let graph: { context: AudioContext; master: GainNode } | null = null;

function enabled(name: UiSound): boolean {
  return sounds[name].alert ? alertSounds : interfaceSounds;
}

function graphFor(): { context: AudioContext; master: GainNode } | null {
  if (graph) return graph;
  if (typeof window === "undefined" || typeof window.AudioContext !== "function")
    return null;
  const context = new window.AudioContext();
  const master = context.createGain();
  master.gain.value = level();
  master.connect(context.destination);
  graph = { context, master };
  return graph;
}

function level(): number {
  return Math.min(1, Math.max(0, volume / 100)) ** 1.6;
}

function load(name: UiSound): Promise<unknown> {
  const pending = loading.get(name);
  if (pending) return pending;
  const audio = graphFor();
  if (!audio) return Promise.resolve();
  const task = fetch(sounds[name].asset)
    .then((response) => response.arrayBuffer())
    .then((data) => audio.context.decodeAudioData(data))
    .then((buffer) => {
      loaded.set(name, buffer);
    })
    .catch(() => {});
  loading.set(name, task);
  return task;
}

function play(name: UiSound): void {
  const audio = graphFor();
  if (!audio) return;
  if (audio.context.state === "suspended") void audio.context.resume();
  const buffer = loaded.get(name);
  if (!buffer) {
    void load(name);
    return;
  }
  const source = audio.context.createBufferSource();
  source.buffer = buffer;
  const gain = audio.context.createGain();
  gain.gain.value = sounds[name].gain;
  source.connect(gain).connect(audio.master);
  source.start();
}

export function configureUiSounds(next: {
  volume: number;
  interfaceSounds: boolean;
  alertSounds: boolean;
}): void {
  volume = next.volume;
  interfaceSounds = next.interfaceSounds;
  alertSounds = next.alertSounds;
  if (graph)
    graph.master.gain.setTargetAtTime(level(), graph.context.currentTime, 0.01);
}

export function unlockUiSounds(): void {
  const audio = graphFor();
  if (!audio) return;
  if (audio.context.state === "suspended") void audio.context.resume();
  for (const name of names) if (enabled(name)) void load(name);
}

export function playUiSound(name: UiSound): void {
  if (!enabled(name)) return;
  play(name);
}

export async function previewUiSound(name: UiSound): Promise<void> {
  unlockUiSounds();
  await load(name);
  play(name);
}
