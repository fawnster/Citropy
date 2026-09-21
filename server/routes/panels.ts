import * as browser from "../browser.ts";
import { computerState, stopComputer } from "../computer.ts";
import { closePanel, openPanel, panelList } from "../panels.ts";
import { store } from "../store.ts";
import * as terminals from "../terminals.ts";
import { resolveWorkspace } from "../workspaces.ts";
import type { Routes } from "./types.ts";

export const panelRoutes: Routes = {
  "panel.open": async (event) => {
    const project = resolveWorkspace(event.projectId, event.threadId);
    if (!project) throw new Error("Open a workspace first");
    if (event.threadId && store.threads.get(event.threadId)?.projectId !== project.id)
      throw new Error("Conversation belongs to another workspace");
    if (event.url !== undefined && (event.kind !== "browser" || !["http:", "https:"].includes(new URL(event.url).protocol)))
      throw new Error("Open a valid HTTP or HTTPS link");
    const panel = openPanel(project.id, event.kind, event.threadId, event.id);
    if (panel.kind !== "browser") return;
    try {
      await browser.openBrowser(project.id, panel.id, event.threadId, event.url);
    } catch (error) {
      if (browser.browserStates().some((tab) => tab.id === panel.id)) return;
      closePanel(panel.id);
      throw error;
    }
  },
  "panel.close": async (event) => {
    if (panelList().some((panel) => panel.id === event.id && panel.kind === "computer" && panel.projectId === computerState().projectId))
      await stopComputer();
    await terminals.close(event.id);
    await browser.closeBrowser(event.id);
    closePanel(event.id);
  },
  "browser.action": async (event) => {
    try {
      await browser.browserAction(event.id, event.input);
    } catch (error) {
      if (!browser.browserStates().some((tab) => tab.id === event.id)) throw error;
    }
  },
};
