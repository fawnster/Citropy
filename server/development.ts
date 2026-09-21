import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dev, developmentOrigin, port } from "./config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

let development: Promise<void> | null = null;

export function startDevelopment(): Promise<void> {
  if (!dev) return Promise.reject(new Error("Start Citropy with --dev to use development tools."));
  if (development) return development;
  development = new Promise<void>((resolve, reject) => {
    const vite = spawn(
      process.execPath,
      [join(root, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1"],
      {
        cwd: root,
        env: { ...process.env, CITROPY_PORT: String(port), CITROPY_DEVELOPMENT: "1", NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    const timer = setTimeout(() => {
      vite.kill();
      reject(new Error("The live interface could not start."));
    }, 15000);
    const clean = () => vite.kill();
    process.once("exit", clean);
    vite.stdout.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-2000);
      if (output.includes(`${developmentOrigin}/`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    vite.stderr.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-2000);
    });
    vite.on("error", (error) => {
      clearTimeout(timer);
      process.off("exit", clean);
      development = null;
      reject(error);
    });
    vite.on("exit", () => {
      clearTimeout(timer);
      process.off("exit", clean);
      development = null;
      reject(new Error(output || "The live interface stopped."));
    });
  });
  return development;
}

export function relaunchServer(desktop: boolean): Promise<void> {
  const launcher = spawn(
    process.execPath,
    [join(root, "desktop/start.mjs"), "--dev", `--after=${process.pid}`, ...(desktop ? [] : ["--server-only"])],
    { cwd: root, detached: true, stdio: "ignore" },
  );
  return new Promise<void>((resolve, reject) => {
    launcher.once("spawn", () => {
      launcher.unref();
      resolve();
    });
    launcher.once("error", reject);
  });
}
