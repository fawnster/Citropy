import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const staging = join(root, ".desktop-build");
const run = (command, args, cwd = root) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited with ${code}`)),
    );
  });
await run(process.execPath, [
  join(root, "node_modules/vite/bin/vite.js"),
  "build",
]);
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
for (const name of [
  "desktop",
  "server",
  "shared",
  "skills",
  "dist",
  "package.json",
  "package-lock.json",
])
  await cp(join(root, name), join(staging, name), { recursive: true });
await cp(join(root, "package-lock.json"), join(staging, "desktop/remote-package-lock.json"));
const manifest = JSON.parse(
  await readFile(join(staging, "package.json"), "utf8"),
);
manifest.main = "desktop/main.mjs";
await writeFile(
  join(staging, "package.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
await run(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["ci", "--omit=dev", "--no-audit", "--no-fund"],
  staging,
);
await run(process.execPath, [
  join(root, "node_modules/electron-builder/cli.js"),
  "--config",
  "desktop/electron-builder.yml",
  "--linux",
  ...(process.argv.includes("--dir") ? ["--dir"] : []),
  "--publish",
  "never",
]);
