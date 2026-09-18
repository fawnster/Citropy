import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const development = process.argv.includes("--dev");
const serverOnly = process.argv.includes("--server-only");
const previous = Number(process.argv.find((arg) => arg.startsWith("--after="))?.slice(8));
const origin = `http://127.0.0.1:${process.env.CITROPY_PORT ?? 4177}`;
function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
if (previous) {
  for (let i = 0; i < 300 && running(previous); i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  if (running(previous)) throw new Error(`The previous Citropy server (process ${previous}) did not stop.`);
}
async function healthy() {
  try {
    const response = await fetch(`${origin}/api/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok && (await response.json()).app === "citropy";
  } catch {
    return false;
  }
}
if (!(await healthy())) {
  const server = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "server/main.ts",
      ...(development ? ["--dev"] : []),
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      detached: true,
      stdio: "ignore",
    },
  );
  server.unref();
  for (let i = 0; i < 50 && !(await healthy()); i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
}
if (serverOnly) process.exit(0);
const response = await fetch(
  `${origin}/api/desktop${development ? "?development=1" : ""}`,
  {
    method: "POST",
    signal: AbortSignal.timeout(55000),
  },
);
if (!response.ok) throw new Error(await response.text());
console.log(
  development
    ? "Citropy desktop is open with live interface updates."
    : "Citropy desktop is open.",
);
