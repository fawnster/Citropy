import * as browser from "../browser.ts";
import { chooseFolder } from "../folder-picker.ts";
import { forgetGit, refreshGit } from "../git-monitor.ts";
import { closePanel, panelList } from "../panels.ts";
import { remoteId, workspaceDirectory } from "../remote.ts";
import { disposeRuntime } from "../runtime.ts";
import { store } from "../store.ts";
import * as terminals from "../terminals.ts";
import type { Routes } from "./types.ts";

export const projectRoutes: Routes = {
  "project.choose": async (event, send) => {
    try {
      if (remoteId && !event.path) throw new Error("Choose a folder on the SSH host.");
      const path = event.path ? await workspaceDirectory(event.path) : await chooseFolder();
      if (!path) return send({ t: "project.chosen", projectId: null });
      const project = store.openProject(path);
      send({ t: "project.chosen", projectId: project.id });
      await refreshGit(project.id, true);
    } catch (error) {
      send({ t: "project.chosen", projectId: null, error: (error as Error).message });
    }
  },
  "project.open": async (event) => {
    const project = store.openProject(event.path);
    await refreshGit(project.id, true);
  },
  "project.close": async (event) => {
    for (const panel of panelList()) {
      if (panel.projectId !== event.id) continue;
      await terminals.close(panel.id);
      await browser.closeBrowser(panel.id);
      closePanel(panel.id);
    }
    for (const thread of store.threads.values()) {
      if (thread.projectId === event.id) disposeRuntime(thread.id);
    }
    store.closeProject(event.id);
    forgetGit(event.id);
  },
};
