import { mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux")
  throw new Error(
    "Use npm run desktop on this platform. The application-menu installer currently supports Linux.",
  );
const root = fileURLToPath(new URL("..", import.meta.url));
const directory = join(
  process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"),
  "applications",
);
mkdirSync(directory, { recursive: true });
const quote = (value) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("`", "\\`").replaceAll("$", "\\$").replaceAll("%", "%%")}"`;
const development = process.argv.includes("--dev");
const name = development ? "Citropy Dev" : "Citropy";
const mode = development ? " --dev" : "";
const path = join(directory, development ? "citropy-dev.desktop" : "citropy.desktop");
writeFileSync(
  path,
  `[Desktop Entry]\nType=Application\nName=${name}\nComment=Your workspace for AI conversations and code\nExec=${quote(process.execPath)} ${quote(join(root, "desktop/start.mjs"))}${mode}\nPath=${root}\nIcon=${join(root, "desktop/assets/citropy.png")}\nTerminal=false\nCategories=Development;IDE;\nStartupWMClass=${name}\n`,
  { mode: 0o755 },
);
chmodSync(path, 0o755);
const previous = join(directory, "loom.desktop");
if (existsSync(previous) && readFileSync(previous, "utf8").includes(join(root, "desktop/start.mjs")))
  unlinkSync(previous);
console.log(`Installed ${name} in your application menu: ${path}`);
