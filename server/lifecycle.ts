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
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      process.stderr.write(`Shutdown step failed: ${(error as Error).message}\n`);
    }
  }
  process.exit(0);
}
