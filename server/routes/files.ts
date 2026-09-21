import * as files from "../files.ts";
import { resolveWorkspace } from "../workspaces.ts";
import type { Routes } from "./types.ts";

export const fileRoutes: Routes = {
  "file.tree": async (event, send) => {
    const project = resolveWorkspace(event.projectId, event.threadId);
    const entries = project ? await files.tree(project.path, event.path ?? "") : [];
    send({ t: "file.tree", requestId: event.requestId, entries });
  },
  "file.read": async (event, send) => {
    const project = resolveWorkspace(event.projectId, event.threadId);
    const content = project ? await files.read(project.path, event.path) : null;
    send({ t: "file.content", requestId: event.requestId, path: event.path, content });
  },
};
