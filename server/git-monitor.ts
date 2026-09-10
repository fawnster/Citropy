import { bus } from "./bus.ts";
import * as git from "./git.ts";
import { workspacePath } from "./workspaces.ts";
import { store } from "./store.ts";

const cache = new Map<string, string>();
const pending = new Map<string, { promise: Promise<void>; repeat: boolean; force: boolean }>();
const running = new Set<string>();

bus.subscribe((event) => {
  if (event.t === "thread.remove") {
    running.delete(event.id);
    for (const key of cache.keys()) if (key.endsWith(`:${event.id}`)) cache.delete(key);
  }
  if (event.t !== "thread.upsert") return;
  if (event.thread.running) running.add(event.thread.id);
  else if (running.delete(event.thread.id)) void refreshGit(event.thread.projectId, true, event.thread.id);
});

export function forgetGit(projectId: string): void {
  for (const key of cache.keys()) if (key === projectId || key.startsWith(`${projectId}:`)) cache.delete(key);
}

export function refreshGit(projectId: string, force = false, threadId?: string): Promise<void> {
  const cacheId = threadId ? `${projectId}:${threadId}` : projectId;
  const active = pending.get(cacheId);
  if (active) {
    if (force) {
      active.repeat = true;
      active.force = true;
    }
    return active.promise;
  }
  const project = store.projects.get(projectId);
  if (!project || (threadId && !store.threads.has(threadId))) return Promise.resolve();
  const path = workspacePath(projectId, threadId);
  const request = { promise: Promise.resolve(), repeat: false, force };
  request.promise = (async () => {
    do {
      request.repeat = false;
      if (store.projects.get(projectId) !== project || !(await git.isRepo(path))) return;
      const status = await git.status(path);
      if (store.projects.get(projectId) !== project || (threadId && !store.threads.has(threadId))) return;
      if (request.repeat) continue;
      const key = JSON.stringify(status);
      if (!request.force && cache.get(cacheId) === key) return;
      cache.set(cacheId, key);
      if (path === project.path && (project.branch !== status.branch || !project.isGit)) {
        project.branch = status.branch;
        project.isGit = true;
        bus.emit({ t: "project.upsert", project });
      }
      bus.emit({ t: "git.status", projectId, ...(threadId ? { threadId } : {}), status });
    } while (request.repeat);
  })().finally(() => pending.delete(cacheId));
  pending.set(cacheId, request);
  return request.promise;
}
