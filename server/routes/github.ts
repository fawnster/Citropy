import { handleGitHub } from "../github.ts";
import { store } from "../store.ts";
import type { Routes } from "./types.ts";

const MUTATING = ["connectRepository", "publishRepository", "clone", "createRepository", "mutate"];

const successTitles: Record<string, string> = {
  clone: "Repository cloned",
  publishRepository: "Repository published",
};

export const githubRoutes: Routes = {
  "github.request": async (event, send) => {
    const { request, requestId } = event;
    const mutating = MUTATING.includes(request.operation);
    const target = { view: "github" as const, projectId: "projectId" in request ? request.projectId : undefined };
    try {
      const result = await handleGitHub(request);
      send({ t: "github.result", requestId, result });
      const clonedNothing =
        request.operation === "clone" && typeof result === "object" && "project" in result && !result.project;
      if (!mutating || clonedNothing) return;
      store.notify({
        kind: "github",
        level: "success",
        title: successTitles[request.operation] ?? "GitHub action completed",
        text:
          typeof result === "object" && "message" in result
            ? result.message
            : "repo" in request
              ? request.repo
              : "Repository is ready",
        target,
      });
    } catch (error) {
      send({ t: "github.result", requestId, error: (error as Error).message });
      if (mutating)
        store.notify({
          kind: "github",
          level: "error",
          title: "GitHub action failed",
          text: (error as Error).message,
          target,
        });
    }
  },
};
