import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export function packagedBackend(env) {
  let child;
  const start = async () => {
    if (child) return;
    await new Promise((resolve, reject) => {
      const probe = createServer();
      probe.once("error", () => reject(new Error("Another server is using Citropy's port. Close it before opening this release.")));
      probe.listen(Number(env.CITROPY_PORT || 4177), "127.0.0.1", () => probe.close(resolve));
    });
    child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        fileURLToPath(new URL("../server/main.ts", import.meta.url)),
        "--packaged",
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    const running = child;
    let output = "";
    running.stderr.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-2000);
    });
    running.once("exit", () => {
      if (child === running) child = undefined;
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            finish(
              new Error("Citropy's server could not start within one minute."),
            ),
          60000,
        );
        const ready = (message) => {
          if (message?.t === "ready") finish();
        };
        const failed = () =>
          finish(
            new Error(
              output.includes("EADDRINUSE")
                ? "Another Citropy server is running. Close it before opening this release."
                : "Citropy's server could not start.",
            ),
          );
        const finish = (error) => {
          clearTimeout(timer);
          running.off("message", ready);
          running.off("error", failed);
          running.off("exit", failed);
          error ? reject(error) : resolve();
        };
        running.on("message", ready);
        running.once("error", failed);
        running.once("exit", failed);
      });
    } catch (error) {
      running.kill("SIGTERM");
      throw error;
    }
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const running = child;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        running.off("exit", exited);
        reject(
          new Error(
            "Citropy's server is still shutting down. The update has not been applied.",
          ),
        );
      }, 15000);
      const exited = () => {
        clearTimeout(timer);
        resolve();
      };
      running.once("exit", exited);
      running.kill("SIGTERM");
    });
  };
  process.once("exit", () => child?.kill("SIGTERM"));
  return { start, stop };
}
