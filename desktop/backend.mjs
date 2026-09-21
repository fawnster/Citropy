import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

function sendShutdown(running) {
  if (!running.connected) return false;
  try {
    return running.send({ t: "shutdown" });
  } catch {
    return false;
  }
}

function waitForExit(running) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      running.off("exit", exited);
      running.kill("SIGTERM");
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
    if (!sendShutdown(running)) running.kill("SIGTERM");
  });
}

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
              new Error(
                `Citropy's server could not start within one minute.${output ? `\n${output.trim().slice(-600)}` : ""}`,
              ),
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
                : `Citropy's server could not start.${output ? `\n${output.trim().slice(-600)}` : ""}`,
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
      void waitForExit(running).catch(() => {});
      throw error;
    }
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    await waitForExit(child);
  };
  process.once("exit", () => {
    // An exit handler cannot wait for IPC delivery, so the shutdown message would not arrive.
    child?.kill("SIGTERM");
  });
  return { start, stop };
}
