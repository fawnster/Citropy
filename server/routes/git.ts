import { bus } from "../bus.ts";
import * as git from "../git.ts";
import { refreshGit } from "../git-monitor.ts";
import { store } from "../store.ts";
import { resolveWorkspace } from "../workspaces.ts";
import type { GitOperation } from "../../shared/protocol.ts";
import type { Routes } from "./types.ts";

const manageTitles: Partial<Record<GitOperation, string>> = {
  push: "Push finished",
  publish: "Branch published",
  pull: "Pull finished",
  fetch: "Fetch finished",
  commit: "Changes committed",
  createBranch: "Branch created",
  switchBranch: "Branch switched",
  deleteBranch: "Branch deleted",
  merge: "Merge finished",
  abortMerge: "Merge cancelled",
  stash: "Changes stashed",
  applyStash: "Stash applied",
  dropStash: "Stash deleted",
  addRemote: "Remote added",
  removeRemote: "Remote removed",
  init: "Repository initialized",
  discardWorktree: "Changes discarded",
};

export const gitRoutes: Routes = {
  "git.manage": async (event, send) => {
    const project = resolveWorkspace(event.projectId, event.threadId);
    if (!project) return send({ t: "git.manage", requestId: event.requestId, error: "Workspace not found" });
    const title = manageTitles[event.operation];
    const target = { view: "git" as const, projectId: project.id, threadId: event.threadId };
    try {
      const result = await git.manage(project.path, event.operation, event.value, event.offset, event.remote);
      send({ t: "git.manage", requestId: event.requestId, result });
      if (title) store.notify({ kind: "git", level: "success", title, text: project.name, target });
    } catch (error) {
      send({ t: "git.manage", requestId: event.requestId, error: (error as Error).message });
      if (title) store.notify({ kind: "git", level: "error", title: "Git action failed", text: (error as Error).message, target });
    }
    await refreshGit(event.projectId, true, event.threadId);
  },
  "git.refresh": async (event) => {
    await refreshGit(event.projectId, true, event.threadId);
  },
  "git.diff": async (event, send) => {
    const project = resolveWorkspace(event.projectId, event.threadId);
    if (!project) return send({ t: "git.diff", requestId: event.requestId, patch: null });
    try {
      const patch = await git.fileDiff(project.path, event.path, event.staged ?? false);
      send({ t: "git.diff", requestId: event.requestId, patch });
    } catch (error) {
      send({ t: "git.diff", requestId: event.requestId, patch: null, error: (error as Error).message });
    }
  },
  "git.discard": async (event) => {
    const project = resolveWorkspace(event.projectId, event.threadId);
    if (!project) return;
    await git.discard(project.path, event.path);
    await refreshGit(event.projectId, true, event.threadId);
    bus.emit({ t: "toast", level: "info", text: `Discarded changes in ${event.path}` });
  },
  "git.commit": async (event) => {
    const project = resolveWorkspace(event.projectId, event.threadId);
    if (!project) return;
    try {
      const out = await git.commit(project.path, event.message);
      store.notify({
        kind: "git",
        level: "success",
        title: "Changes committed",
        text: out.split("\n")[0] ?? project.name,
        target: { view: "git", projectId: project.id, threadId: event.threadId },
      });
    } catch (error) {
      bus.emit({ t: "toast", level: "error", text: (error as Error).message.split("\n")[0] ?? "Commit failed" });
    }
    await refreshGit(event.projectId, true, event.threadId);
  },
};
