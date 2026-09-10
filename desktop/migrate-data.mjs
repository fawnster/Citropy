import { existsSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

export function migrateDesktopData(appData, override) {
  const root = override ?? join(appData, "Citropy");
  const previous = join(appData, "Loom");
  if (!override && !existsSync(root) && existsSync(previous))
    renameSync(previous, root);
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
