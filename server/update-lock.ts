let locked = false;
let timer: ReturnType<typeof setTimeout> | undefined;

export function assertApplicationReady(): void {
  if (locked)
    throw new Error(
      "Citropy is restarting to apply an update. Try again after it opens.",
    );
}

export function lockForAppUpdate(): void {
  assertApplicationReady();
  locked = true;
  timer = setTimeout(() => {
    locked = false;
    timer = undefined;
  }, 60000);
  timer.unref();
}

export function unlockAppUpdate(): void {
  clearTimeout(timer);
  timer = undefined;
  locked = false;
}
