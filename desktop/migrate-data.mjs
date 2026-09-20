import { existsSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

export function migrateDesktopData(appData, override) {
  const root = override ?? join(appData, "Citropy");
  const previous = join(appData, "Loom");
  const lemon = join(appData, "Citropy Lemon");
  if (!override && !existsSync(root)) {
    const legacy = existsSync(lemon) ? lemon : existsSync(previous) ? previous : undefined;
    if (legacy) {
      try {
        renameSync(legacy, root);
      } catch {
        // the older build can still hold its profile open on Windows
      }
    }
  }
  const partitions = join(root, "Partitions");
  if (existsSync(partitions)) {
    for (const name of readdirSync(partitions)) {
      if (!name.startsWith("loom-")) continue;
      const destination = join(partitions, `citropy-${name.slice(5)}`);
      if (!existsSync(destination)) renameSync(join(partitions, name), destination);
    }
  }
  return root;
}
