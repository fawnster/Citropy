type TeardownStep = () => void | Promise<void>;

const steps: TeardownStep[] = [];
let stopping = false;

export function onShutdown(step: TeardownStep): void {
  steps.push(step);
}

export function shuttingDown(): boolean {
  return stopping;
}

export async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  for (const step of steps) await step();
  process.exit(0);
}
