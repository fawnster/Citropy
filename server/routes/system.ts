import { activeWork } from "../activity.ts";
import { computerState } from "../computer.ts";
import { dev } from "../config.ts";
import { desktopConnected, openDesktop } from "../desktop.ts";
import { relaunchServer } from "../development.ts";
import { shutdown } from "../lifecycle.ts";
import { remoteId } from "../remote.ts";
import { store } from "../store.ts";
import type { Routes } from "./types.ts";

async function restartDevelopmentServer(): Promise<void> {
  if (!dev || remoteId) throw new Error("Restarting the server is available only in development.");
  if (activeWork(1) || computerState().status !== "idle")
    throw new Error("Finish active conversations, updates, Git operations, and computer use before restarting the server.");
  store.flush();
  await relaunchServer(desktopConnected());
  void shutdown();
}

export const systemRoutes: Routes = {
  "desktop.open": async () => {
    await openDesktop();
  },
  "server.restart": async () => {
    await restartDevelopmentServer();
  },
};
