import type { IncomingMessage, ServerResponse } from "node:http";
import { store } from "./store.ts";
import { dev } from "./config.ts";
import { desktopRequest } from "./desktop.ts";
import { reloadProviderSessions, providerBusy, runtimeFor } from "./runtime.ts";
import { providerMaintenance, startProviderUpdate, assertProviderReady } from "./providers/maintenance.ts";
import { readGlobalInstructions, saveGlobalInstructions } from "./providers/instructions.ts";
import { waitForStoppedProcesses } from "./providers/process.ts";
import { openPanel } from "./panels.ts";
import * as terminals from "./terminals.ts";
import { modelSettings } from "../shared/model-options.ts";
import {
  chooseThreadWorkspace,
  workspaceOptions,
  workspacePath,
} from "./workspaces.ts";
import {
  uploadAttachment,
  removeAttachment,
  previewFile,
  serveAsset,
} from "./assets.ts";
import { changeSkill, listSkills, readSkill, restoreComputerSkill } from "./skills.ts";
import { diagnostics } from "./diagnostics.ts";
import { usageReport } from "./usage.ts";
import { configureAssistance, generateThreadTitle, startGitAction } from "./assistance.ts";
import { listCommands } from "./commands.ts";
import { computerState, computerCapabilities, configureComputer, startComputer, stopComputer, pauseComputer, computerScreenshot, computerAction } from "./computer.ts";
import type { ComputerAction } from "../shared/computer.ts";
import type { ProjectSettings, ProviderId, ProviderInfo } from "../shared/protocol.ts";

async function body(req: IncomingMessage): Promise<Record<string, any>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128 * 1024) throw new Error("Request is too large.");
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid request");
  return value;
}

function settings(
  input: Record<string, any>,
  providers: ProviderInfo[],
): ProjectSettings {
  const out: ProjectSettings = {};
  if (input.provider !== undefined) {
    if (!providers.some((provider) => provider.id === input.provider))
      throw new Error("Unknown provider");
    out.provider = input.provider;
  }
  if (input.model) {
    const model = providers
      .find((provider) => provider.id === out.provider)
      ?.models.find((model) => model.id === input.model);
    if (!model) throw new Error("Select an available model.");
    out.model = model.id;
    if (input.effort) {
      if (!model.efforts?.includes(input.effort))
        throw new Error("This model does not support that effort.");
      out.effort = input.effort;
    }
  }
  if (input.permissionMode) {
    if (
      !["manual", "acceptEdits", "plan", "bypass"].includes(
        input.permissionMode,
      )
    )
      throw new Error("Unknown permission mode");
    out.permissionMode = input.permissionMode;
  }
  if (input.workspace) {
    if (!["current", "new"].includes(input.workspace))
      throw new Error("Unknown workspace preference");
    out.workspace = input.workspace;
  }
  for (const key of ["autoPull", "browserAccess"] as const)
    if (input[key] !== undefined) {
      if (typeof input[key] !== "boolean")
        throw new Error(`Invalid ${key} setting`);
      out[key] = input[key];
    }
  if (input.actions !== undefined) {
    if (!Array.isArray(input.actions) || input.actions.length > 20)
      throw new Error("Add up to 20 project actions.");
    out.actions = input.actions.map((entry: any) => {
      if (
        typeof entry.id !== "string" ||
        typeof entry.name !== "string" ||
        !entry.name.trim() ||
        typeof entry.command !== "string" ||
        !entry.command.trim() ||
        entry.command.length > 8000
      )
        throw new Error("Every action needs a name and command.");
      return {
        id: entry.id.slice(0, 80),
        name: entry.name.trim().slice(0, 80),
        command: entry.command,
        setup: entry.setup === true,
      };
    });
    if (
      new Set(out.actions!.map((action) => action.id)).size !==
        out.actions!.length ||
      new Set(out.actions!.map((action) => action.name.toLowerCase())).size !==
        out.actions!.length
    )
      throw new Error("Give each project action a different name.");
  }
  return out;
}

export async function handleFeatures(
  req: IncomingMessage,
  res: ServerResponse,
  providers: ProviderInfo[],
  refreshProviders: () => Promise<void> = async () => {},
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (
    !/^\/api\/(attachments|assets|preview|workspaces|projects|threads|commands|skills|usage|diagnostics|browser|computer|providers)(\/|$)/.test(
      url.pathname,
    )
  )
    return false;
  try {
    const host = new URL(`http://${req.headers.host || "localhost"}`);
    const requestOrigin = req.headers.origin
      ? new URL(req.headers.origin)
      : undefined;
    const local = ["127.0.0.1", "localhost", "[::1]"];
    if (
      !local.includes(host.hostname) ||
      (requestOrigin &&
        (!local.includes(requestOrigin.hostname) ||
          requestOrigin.protocol !== "http:" ||
          (requestOrigin.port !== host.port &&
            !(dev && requestOrigin.port === "5177")))) ||
      req.headers["sec-fetch-site"] === "cross-site"
    )
      throw new Error("Invalid origin");
  } catch {
    res.writeHead(403).end();
    return true;
  }
  const projectId = url.searchParams.get("projectId") || undefined;
  const threadId = url.searchParams.get("threadId") || undefined;
  const respond = (value: unknown) => {
    res
      .writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      })
      .end(JSON.stringify(value));
  };
  try {
    if (url.pathname === "/api/providers/assistance" && req.method === "GET") respond(store.assistance);
    else if (url.pathname === "/api/providers/assistance" && req.method === "PATCH") respond(configureAssistance(await body(req), providers));
    else if (url.pathname === "/api/threads/git-action" && req.method === "POST") {
      const input = await body(req);
      respond(startGitAction(threadId ?? "", input.action, input.scope));
    } else if (url.pathname === "/api/threads/title" && req.method === "POST") {
      await generateThreadTitle(threadId ?? "");
      respond({ ok: true });
    } else if (url.pathname === "/api/providers/maintenance" && req.method === "GET") respond(await providerMaintenance(url.searchParams.get("refresh") === "1"));
    else if (url.pathname === "/api/providers/update" && req.method === "POST") {
      const input = await body(req);
      if (!["claude", "codex", "opencode"].includes(input.provider)) throw new Error("Unknown provider.");
      const provider = input.provider as ProviderId;
      if (providerBusy(provider)) throw new Error("Finish or stop this provider’s active conversations before updating.");
      respond(startProviderUpdate(provider, async () => {
        reloadProviderSessions(new Set([provider]));
        await waitForStoppedProcesses();
      }, refreshProviders));
    } else if (url.pathname === "/api/providers/instructions" && ["GET", "PUT"].includes(req.method || "")) {
      const provider = url.searchParams.get("provider") as ProviderId;
      if (!["claude", "codex", "opencode"].includes(provider)) throw new Error("Unknown provider.");
      if (req.method === "GET") respond(readGlobalInstructions(provider));
      else {
        const input = await body(req);
        assertProviderReady(provider);
        if (providerBusy(provider)) throw new Error("Finish or stop this provider’s active conversations before saving global instructions.");
        const saved = saveGlobalInstructions(provider, input.content, input.revision);
        reloadProviderSessions(new Set([provider]));
        respond(saved);
      }
    } else if (url.pathname === "/api/computer" && req.method === "GET") respond({ state: computerState(), capabilities: await computerCapabilities().catch((error) => ({ available: false, platform: process.platform, backend: "unavailable", reason: error.message })) });
    else if (url.pathname === "/api/computer" && req.method === "PATCH") {
      const input = await body(req);
      respond(await configureComputer(input.enabled));
    } else if (url.pathname === "/api/computer/start" && req.method === "POST") respond(await startComputer(threadId ?? "", true));
    else if (url.pathname === "/api/computer/stop" && req.method === "POST") respond(await stopComputer());
    else if (url.pathname === "/api/computer/pause" && req.method === "POST") {
      const input = await body(req);
      if (typeof input.paused !== "boolean") throw new Error("Choose whether to pause control.");
      respond(await pauseComputer(input.paused));
    } else if (url.pathname === "/api/computer/screenshot" && req.method === "GET") respond(await computerScreenshot(threadId ?? "", { displayId: url.searchParams.get("displayId") || undefined, maxWidth: Number(url.searchParams.get("maxWidth") || 1600), preview: true }));
    else if (url.pathname === "/api/computer/action" && req.method === "POST") respond(await computerAction(threadId ?? "", await body(req) as ComputerAction, true));
    else if (url.pathname === "/api/computer/skill" && req.method === "POST") {
      await restoreComputerSkill();
      respond({ ok: true });
    } else if (
      url.pathname === "/api/assets" &&
      ["GET", "HEAD"].includes(req.method ?? "")
    )
      await serveAsset(req, res, url.searchParams);
    else if (url.pathname === "/api/preview" && req.method === "GET")
      respond(await previewFile(url.searchParams));
    else if (url.pathname === "/api/attachments" && req.method === "POST")
      respond(
        await uploadAttachment(
          req,
          threadId ?? "",
          url.searchParams.get("name") ?? "",
        ),
      );
    else if (url.pathname === "/api/attachments" && req.method === "DELETE") {
      await removeAttachment(threadId ?? "", url.searchParams.get("id") ?? "");
      respond({ ok: true });
    } else if (url.pathname === "/api/workspaces" && req.method === "GET") {
      const project = store.projects.get(projectId ?? "");
      if (!project) throw new Error("Workspace not found");
      respond(await workspaceOptions(project));
    } else if (url.pathname === "/api/projects" && req.method === "PATCH") {
      const input = await body(req);
      const project = store.projects.get(projectId ?? "");
      if (!project) throw new Error("Workspace not found");
      const name =
        typeof input.name === "string"
          ? input.name.trim().slice(0, 80)
          : project.name;
      if (!name) throw new Error("Project name cannot be empty.");
      respond(
        store.updateProject(project.id, {
          name,
          settings: settings(input.settings ?? {}, providers),
        }),
      );
    } else if (
      url.pathname === "/api/projects/action" &&
      req.method === "POST"
    ) {
      const input = await body(req);
      const project = store.projects.get(projectId ?? "");
      const action = project?.settings?.actions?.find(
        (entry) => entry.id === input.id,
      );
      if (!project || !action) throw new Error("Project action not found");
      const panel = openPanel(project.id, "terminal", threadId);
      terminals.open(
        panel.id,
        workspacePath(project.id, threadId),
        100,
        28,
        action.command,
      );
      respond(panel);
    } else if (url.pathname === "/api/threads" && req.method === "POST") {
      const input = await body(req);
      const project = store.projects.get(input.projectId);
      if (!project) throw new Error("Workspace not found");
      const defaults = project.settings;
      const provider = providers.find(
        (entry) => entry.id === (input.provider ?? defaults?.provider),
      );
      if (!provider?.available || !provider.enabled)
        throw new Error("Select an enabled, installed provider.");
      if (
        input.permissionMode &&
        !["manual", "acceptEdits", "plan", "bypass"].includes(
          input.permissionMode,
        )
      )
        throw new Error("Unknown permission mode");
      const workspace = await chooseThreadWorkspace(project, input.workspace);
      const thread = store.createThread({
        projectId: project.id,
        provider: provider.id,
        ...workspace,
        ...modelSettings(provider.models, {
          model:
            input.model ??
            (provider.id === defaults?.provider ? defaults.model : undefined),
          effort: input.effort ?? defaults?.effort,
        }),
        permissionMode:
          input.permissionMode ?? defaults?.permissionMode ?? "manual",
        title: "New thread",
      });
      if ((input.workspace?.kind ?? defaults?.workspace) === "new")
        for (const action of defaults?.actions ?? [])
          if (action.setup) {
            const panel = openPanel(project.id, "terminal", thread.id);
            terminals.open(
              panel.id,
              workspace.workspacePath,
              100,
              28,
              action.command,
            );
          }
      respond(store.meta(thread));
    } else if (
      url.pathname === "/api/threads/organize" &&
      req.method === "PATCH"
    ) {
      const input = await body(req);
      const patch: Parameters<typeof store.organizeThread>[1] = {};
      if (input.title !== undefined) {
        if (typeof input.title !== "string" || !input.title.trim())
          throw new Error("Enter a conversation name.");
        patch.title = input.title.trim().slice(0, 200);
      }
      for (const key of ["pinned", "archived"] as const)
        if (input[key] !== undefined) {
          if (typeof input[key] !== "boolean")
            throw new Error("Invalid conversation state");
          patch[key] = input[key];
        }
      if (input.snoozedUntil !== undefined) {
        if (
          input.snoozedUntil !== null &&
          (!Number.isFinite(input.snoozedUntil) ||
            input.snoozedUntil < Date.now() ||
            input.snoozedUntil > Date.now() + 365 * 86400_000)
        )
          throw new Error("Choose a future wake time within a year.");
        patch.snoozedUntil = input.snoozedUntil ?? undefined;
      }
      if (input.pullRequest !== undefined) {
        if (
          input.pullRequest &&
          !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/.test(
            input.pullRequest,
          )
        )
          throw new Error("Enter a GitHub pull request URL.");
        patch.pullRequest = input.pullRequest || undefined;
      }
      store.organizeThread(threadId ?? "", patch);
      respond({ ok: true });
    } else if (
      url.pathname === "/api/threads/reorder" &&
      req.method === "POST"
    ) {
      const input = await body(req);
      if (
        !Array.isArray(input.ids) ||
        input.ids.length > 10_000 ||
        new Set(input.ids).size !== input.ids.length
      )
        throw new Error("Invalid conversation order");
      for (const id of input.ids)
        if (store.threads.get(id)?.projectId !== projectId)
          throw new Error("Conversations belong to different workspaces.");
      input.ids.forEach((id: string, index: number) =>
        store.organizeThread(id, { position: index }),
      );
      respond({ ok: true });
    } else if (
      url.pathname === "/api/threads/compact" &&
      req.method === "POST"
    ) {
      await runtimeFor(threadId ?? "").compact();
      respond({ ok: true });
    } else if (url.pathname === "/api/commands" && req.method === "GET") {
      const thread = store.threads.get(threadId ?? "");
      if (!thread) throw new Error("Conversation not found");
      if (store.disabledProviders.has(thread.provider))
        throw new Error("Enable this provider to load its commands.");
      respond(
        await listCommands(
          thread.provider,
          workspacePath(thread.projectId, thread.id),
        ),
      );
    } else if (url.pathname === "/api/skills" && req.method === "GET") {
      const id = url.searchParams.get("id");
      respond(
        id
          ? { content: await readSkill(projectId, id) }
          : await listSkills(projectId, threadId),
      );
    } else if (url.pathname === "/api/skills" && req.method === "PATCH") {
      const input = await body(req);
      reloadProviderSessions(
        await changeSkill(projectId, input.id, input.action),
      );
      respond(await listSkills(projectId));
    } else if (url.pathname === "/api/usage" && req.method === "GET")
      respond(
        await usageReport(
          providers
            .filter((entry) => entry.available && entry.enabled)
            .map((entry) => entry.id),
        ),
      );
    else if (url.pathname === "/api/diagnostics" && req.method === "GET")
      respond(await diagnostics());
    else if (
      url.pathname.startsWith("/api/browser/") &&
      ["GET", "POST", "DELETE"].includes(req.method ?? "")
    ) {
      if (!store.projects.has(projectId ?? ""))
        throw new Error("Workspace not found");
      const operation = url.pathname.slice("/api/browser/".length);
      if (!["profiles", "sources", "import", "clear"].includes(operation))
        throw new Error("Unknown browser action");
      const input = req.method === "GET" ? {} : await body(req);
      respond(
        await desktopRequest(`profiles.${operation}`, {
          ...input,
          projectId,
          method: req.method,
        }),
      );
    } else {
      res.writeHead(404).end();
    }
  } catch (error) {
    if (!res.headersSent && !res.destroyed)
      res
        .writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ error: (error as Error).message }));
  }
  return true;
}
