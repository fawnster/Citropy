import { authorizeRemote, remoteId, workspaceDirectory } from "./remote.ts";
import { assertApplicationReady, lockForAppUpdate, unlockAppUpdate } from "./update-lock.ts";
import { assistanceBusy } from "./assistance.ts";
import { providerUpdating, startProviderUpdateChecks } from "./providers/maintenance.ts";
import { notifyUpdateAvailable } from "./update-notifications.ts";
import { handleFeatures } from "./features.ts";
import { computerState, stopComputer } from "./computer.ts";
import { workspacePath, chooseThreadWorkspace } from "./workspaces.ts";
import { handleGitHub } from "./github.ts";
import { searchConversations } from "./conversation-search.ts";
import { createServer, type IncomingMessage } from "node:http";
import { spawn } from "node:child_process";
import { pendingQuestions } from "./questions.ts";
import { shellList } from "./shells.ts";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { bus } from "./bus.ts";
import { eventJournal } from "./event-journal.ts";
import { randomUUID } from "node:crypto";
import { dev, developmentOrigin, host, origin, port } from "./config.ts";
import { chooseFolder } from "./folder-picker.ts";
import * as files from "./files.ts";
import * as git from "./git.ts";
import { refreshGit, forgetGit } from "./git-monitor.ts";
import { answer as answerPermission } from "./permissions.ts";
import { pendingRequests } from "./permissions.ts";
import { handleMcp, workspaceTools } from "./mcp.ts";
import { toolConnections } from "./mcp-access.ts";
import * as browser from "./browser.ts";
import {
  openDesktop,
  desktopConnected,
  attachDesktop,
  authorizeDesktop,
  desktopRequest,
  desktopEvents,
} from "./desktop.ts";
import { panelList, openPanel, closePanel } from "./panels.ts";
import { describeProviders } from "./providers/index.ts";
import { waitForStoppedProcesses } from "./providers/process.ts";
import { disposeAll, disposeRuntime, runtimeFor, runtimeIfExists, providerBusy } from "./runtime.ts";
import { serveStatic } from "./static.ts";
import { store } from "./store.ts";
import { modelSettings, selectedModel } from "../shared/model-options.ts";
import * as terminals from "./terminals.ts";
import type { ClientEvent, ProviderInfo, ServerEvent, Snapshot } from "../shared/protocol.ts";

if (process.versions.electron) delete process.env.ELECTRON_RUN_AS_NODE;

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", "dist");

let providerInfo: ProviderInfo[] = [];
let refreshingProviders: Promise<void> | null = null;
let lastProviderRefresh = 0;
let development: Promise<void> | null = null;
let shuttingDown = false;
let activeCommands = 0;
const connectionEpoch = randomUUID();
const activeRequests = new Set<IncomingMessage>();

function activeWork(ownCommands = 0): boolean {
  return (["claude", "codex", "opencode", "cursor"] as const).some(id => providerBusy(id) || providerUpdating(id)) || assistanceBusy() || activeCommands > ownCommands || activeRequests.size > 0 || pendingRequests().length > 0;
}

async function restartDevelopmentServer(): Promise<void> {
  if (!dev || remoteId) throw new Error("Restarting the server is available only in development.");
  if (activeWork(1) || computerState().status !== "idle") throw new Error("Finish active conversations, updates, Git operations, and computer use before restarting the server.");
  store.flush();
  const launcher = spawn(process.execPath, [join(here, "../desktop/start.mjs"), "--dev", `--after=${process.pid}`, ...(desktopConnected() ? [] : ["--server-only"])], {
    cwd: join(here, ".."),
    detached: true,
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => { launcher.once("spawn", resolve); launcher.once("error", reject); });
  launcher.unref();
  void shutdown();
}

function startDevelopment(): Promise<void> {
  if (!dev) return Promise.reject(new Error("Start Citropy with --dev to use development tools."));
  if (development) return development;
  development = new Promise<void>((resolve, reject) => {
    const vite = spawn(
      process.execPath,
      [join(here, "../node_modules/vite/bin/vite.js"), "--host", "127.0.0.1"],
      {
        cwd: join(here, ".."),
        env: { ...process.env, CITROPY_PORT: String(port), CITROPY_DEVELOPMENT: "1", NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    const timer = setTimeout(() => {
      vite.kill();
      reject(new Error("The live interface could not start."));
    }, 15000);
    const clean = () => vite.kill();
    process.once("exit", clean);
    vite.stdout.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-2000);
      if (output.includes(`${developmentOrigin}/`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    vite.stderr.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-2000);
    });
    vite.on("error", (error) => {
      clearTimeout(timer);
      process.off("exit", clean);
      development = null;
      reject(error);
    });
    vite.on("exit", () => {
      clearTimeout(timer);
      process.off("exit", clean);
      development = null;
      reject(new Error(output || "The live interface stopped."));
    });
  });
  return development;
}

function refreshProviders(force = false): Promise<void> {
  if (refreshingProviders) return force ? refreshingProviders.then(() => refreshProviders(true)) : refreshingProviders;
  if (!force && Date.now() - lastProviderRefresh < 30_000) return Promise.resolve();
  refreshingProviders = describeProviders().then((info) => {
    providerInfo = info.map((provider) => ({ ...provider, enabled: !store.disabledProviders.has(provider.id) }));
    lastProviderRefresh = Date.now();
    bus.emit({ t: "providers.update", providers: providerInfo });
  }).finally(() => { refreshingProviders = null; });
  return refreshingProviders;
}

bus.subscribe((event) => {
  if (event.t === "notification.add" && store.notificationPreferences.desktop)
    void desktopRequest("notification", {
      ...event.notification,
      silent: !store.notificationPreferences.sound,
    }).catch(() => {});
});

function snapshot(): Snapshot {
  return {
    shells: shellList(),
    projectDefaults: store.projectDefaults,
    assistance: store.assistance,
    computer: computerState(),
    notifications: store.notifications,
    notificationPreferences: store.notificationPreferences,
    panels: panelList(),
    browsers: browser.browserStates(),
    tools: workspaceTools,
    toolConnections: toolConnections(),
    permissions: pendingRequests(),
    questions: pendingQuestions(),
    development: dev,
    projects: [...store.projects.values()].sort((a, b) => b.lastOpened - a.lastOpened),
    threads: store.allMeta().sort((a, b) => b.updatedAt - a.updatedAt),
    providers: providerInfo,
    home: homedir(),
  };
}

async function handle(event: ClientEvent, send: (event: ServerEvent) => void): Promise<void> {
  if (shuttingDown) throw new Error("Citropy is shutting down. Reconnect before trying again.");
  switch (event.t) {
    case "notifications.read":
      store.readNotifications(event.ids);
      return;
    case "notifications.clear":
      store.clearNotifications();
      return;
    case "notifications.configure":
      store.configureNotifications(event.preferences);
      return;
    case "desktop.open": await openDesktop(); return;
    case "server.restart": await restartDevelopmentServer(); return;
    case "panel.open": {
      const source = store.projects.get(event.projectId);
      const project = source ? { ...source, path: workspacePath(source.id, event.threadId) } : undefined;
      if (!project) throw new Error("Open a workspace first");
      if (event.threadId && store.threads.get(event.threadId)?.projectId !== project.id) throw new Error("Conversation belongs to another workspace");
      if (event.url !== undefined && (event.kind !== "browser" || !["http:", "https:"].includes(new URL(event.url).protocol))) throw new Error("Open a valid HTTP or HTTPS link");
      const panel = openPanel(project.id, event.kind, event.threadId, event.id);
      if (panel.kind === "browser") {
        try { await browser.openBrowser(project.id, panel.id, event.threadId, event.url); }
        catch (error) { if (!browser.browserStates().some((tab) => tab.id === panel.id)) { closePanel(panel.id); throw error; } }
      }
      return;
    }
    case "panel.close":
      if (panelList().some((panel) => panel.id === event.id && panel.kind === "computer" && panel.projectId === computerState().projectId)) await stopComputer();
      await terminals.close(event.id);
      await browser.closeBrowser(event.id);
      closePanel(event.id);
      return;
    case "browser.action":
      try { await browser.browserAction(event.id, event.input); }
      catch (error) { if (!browser.browserStates().some((tab) => tab.id === event.id)) throw error; }
      return;
    case "github.request": {
      const mutating = [
        "connectRepository",
        "publishRepository",
        "clone",
        "createRepository",
        "mutate",
      ].includes(event.request.operation);
      const target = {
        view: "github" as const,
        projectId:
          "projectId" in event.request ? event.request.projectId : undefined,
      };
      try {
        const result = await handleGitHub(event.request);
        send({ t: "github.result", requestId: event.requestId, result });
        if (
          mutating &&
          !(
            event.request.operation === "clone" &&
            typeof result === "object" &&
            "project" in result &&
            !result.project
          )
        )
          store.notify({
            kind: "github",
            level: "success",
            title:
              event.request.operation === "clone"
                ? "Repository cloned"
                : event.request.operation === "publishRepository"
                  ? "Repository published"
                  : "GitHub action completed",
            text:
              typeof result === "object" && "message" in result
                ? result.message
                : "repo" in event.request
                  ? event.request.repo
                  : "Repository is ready",
            target,
          });
      } catch (error) {
        send({
          t: "github.result",
          requestId: event.requestId,
          error: (error as Error).message,
        });
        if (mutating)
          store.notify({
            kind: "github",
            level: "error",
            title: "GitHub action failed",
            text: (error as Error).message,
            target,
          });
      }
      return;
    }
    case "project.choose": {
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
      return;
    }
    case "providers.configure":
      store.setProviderEnabled(event.provider, event.enabled);
      if (!event.enabled) {
        for (const thread of store.threads.values()) {
          if (thread.provider === event.provider) disposeRuntime(thread.id);
        }
      }
      providerInfo = providerInfo.map((provider) => ({ ...provider, enabled: !store.disabledProviders.has(provider.id) }));
      bus.emit({ t: "providers.update", providers: providerInfo });
      if (event.enabled) {
        if (refreshingProviders) await refreshingProviders;
        lastProviderRefresh = 0;
        await refreshProviders();
      }
      return;
    case "providers.refresh":
      await refreshProviders();
      return;
    case "project.open": {
      const project = store.openProject(event.path);
      await refreshGit(project.id, true);
      return;
    }
    case "project.close":
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
      return;
    case "thread.create": {
      const provider = providerInfo.find((entry) => entry.id === event.provider);
      if (!provider?.available) throw new Error("This provider is not available on this computer.");
      const project = store.projects.get(event.projectId);
      if (!project) throw new Error("Workspace not found");
      const workspace = await chooseThreadWorkspace(project, event.workspace);
      const thread = store.createThread({
        ...workspace,
        projectId: event.projectId,
        provider: event.provider,
        ...modelSettings(provider.models, {
          model: event.model,
          effort: event.effort ?? undefined,
          contextWindow: event.contextWindow,
          fastMode: event.fastMode,
        }),
        title: event.title ?? "New thread",
        permissionMode: event.permissionMode ?? "manual",
      });
      send({ t: "thread.messages", threadId: thread.id, messages: thread.messages });
      return;
    }
    case "thread.send":
      await runtimeFor(event.threadId).send(event.text, event.attachments);
      if (event.requestId) send({ t: "thread.accepted", requestId: event.requestId });
      return;
    case "thread.stop":
      runtimeFor(event.threadId).stop();
      return;
    case "queue.send":
      await runtimeFor(event.threadId).sendNow(event.id);
      return;
    case "queue.remove":
      await runtimeFor(event.threadId).removeQueued(event.id);
      return;
    case "queue.move":
      runtimeFor(event.threadId).moveQueued(event.id, event.index);
      return;
    case "queue.edit":
      runtimeFor(event.threadId).takeQueued(event.id);
      send({ t: "thread.accepted", requestId: event.requestId });
      return;
    case "thread.remove":
      disposeRuntime(event.id);
      store.removeThread(event.id);
      return;
    case "thread.finish":
      store.setThreadFinished(event.id, event.finished);
      return;
    case "thread.search":
      send({ t: "thread.search", query: event.query, projectId: event.projectId, results: searchConversations(store.threads.values(), event.query, event.projectId) });
      return;
    case "thread.load": {
      const thread = store.threads.get(event.id);
      if (thread) send({ t: "thread.messages", threadId: thread.id, messages: thread.messages });
      return;
    }
    case "thread.config": {
      const thread = store.threads.get(event.id);
      if (!thread) throw new Error("Conversation not found");
      const changedProvider = event.provider !== undefined && event.provider !== thread.provider;
      const provider = providerInfo.find((entry) => entry.id === (event.provider ?? thread.provider));
      if (changedProvider) {
        if (!provider?.available || !provider.enabled)
          throw new Error("Select an enabled, installed provider.");
        if (thread.messages.length || thread.externalId || thread.parentThreadId || thread.running || thread.queue?.length || thread.compacting || [...store.threads.values()].some((entry) => entry.parentThreadId === thread.id))
          throw new Error("Start a new thread to use a different provider after sending a message.");
      }
      const models =
        provider?.models ?? [];
      const model = selectedModel(models, event.model ?? (changedProvider ? undefined : thread.model));
      if (event.model && !model)
        throw new Error(
          "This model is no longer available. Refresh the model list.",
        );
      if (event.effort && !model?.efforts?.includes(event.effort))
        throw new Error("This effort is not supported by the selected model");
      if (
        event.contextWindow !== undefined &&
        !model?.contextWindows?.includes(event.contextWindow)
      )
        throw new Error(
          "This context size is not supported by the selected model",
        );
      if (
        event.fastMode !== undefined &&
        (typeof event.fastMode !== "boolean" ||
          (event.fastMode && !model?.fastMode))
      )
        throw new Error("Fast mode is not supported by the selected model");
      const changedModel =
        changedProvider || (event.model !== undefined && event.model !== thread.model);
      const settings = modelSettings(models, {
        model: event.model ?? (changedProvider ? model?.id : thread.model),
        effort:
          event.effort === null || changedModel
            ? (event.effort ?? undefined)
            : (event.effort ?? thread.effort),
        contextWindow:
          event.contextWindow ??
          (changedModel ? undefined : thread.contextWindow),
        fastMode: event.fastMode ?? (changedModel ? false : thread.fastMode),
      });
      const restart =
        changedProvider ||
        Object.entries(settings).some(
          ([key, value]) => thread[key as keyof typeof settings] !== value,
        ) ||
        (event.permissionMode !== undefined &&
          event.permissionMode !== thread.permissionMode);
      if (restart && thread.running)
        throw new Error(
          "Wait for this turn to finish before changing its settings.",
        );
      let live = false;
      if (restart) {
        if (!changedProvider) {
          const existing = runtimeIfExists(event.id);
          if (existing)
            live = await existing.configure({
              model: settings.model,
              effort: settings.effort,
              contextMax: settings.contextWindow,
              fastMode: settings.fastMode,
              permissionMode: event.permissionMode ?? thread.permissionMode,
            });
        }
        if (!live) disposeRuntime(event.id, true);
      }
      store.patchThread(event.id, {
        provider: event.provider ?? thread.provider,
        ...settings,
        // A live reconfigure already reported the real window through its session event.
        ...(!live && (changedModel || settings.contextWindow !== thread.contextWindow) ? { usage: { ...thread.usage, contextMax: 0 } } : {}),
        permissionMode: event.permissionMode ?? thread.permissionMode,
        title: event.title ?? thread.title,
      });
      if (event.requestId) send({ t: "thread.accepted", requestId: event.requestId });
      return;
    }
    case "permission.answer":
      answerPermission(event.id, event.decision);
      return;
    case "git.manage": {
      const source = store.projects.get(event.projectId);
      const project = source ? { ...source, path: workspacePath(source.id, event.threadId) } : undefined;
      if (!project) return send({ t: "git.manage", requestId: event.requestId, error: "Workspace not found" });
      const titles: Partial<Record<typeof event.operation, string>> = {
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
      try {
        const result = await git.manage(project.path, event.operation, event.value, event.offset, event.remote);
        send({ t: "git.manage", requestId: event.requestId, result });
        if (titles[event.operation])
          store.notify({
            kind: "git",
            level: "success",
            title: titles[event.operation]!,
            text: project.name,
            target: { view: "git", projectId: project.id, threadId: event.threadId },
          });
      } catch (error) {
        send({ t: "git.manage", requestId: event.requestId, error: (error as Error).message });
        if (titles[event.operation])
          store.notify({
            kind: "git",
            level: "error",
            title: "Git action failed",
            text: (error as Error).message,
            target: { view: "git", projectId: project.id, threadId: event.threadId },
          });
      }
      await refreshGit(event.projectId, true, event.threadId);
      return;
    }
    case "git.refresh":
      await refreshGit(event.projectId, true, event.threadId);
      return;
    case "git.diff": {
      const source = store.projects.get(event.projectId);
      const project = source ? { ...source, path: workspacePath(source.id, event.threadId) } : undefined;
      if (!project) return send({ t: "git.diff", requestId: event.requestId, patch: null });
      try {
        const patch = await git.fileDiff(project.path, event.path, event.staged ?? false);
        return send({ t: "git.diff", requestId: event.requestId, patch });
      } catch (error) {
        return send({ t: "git.diff", requestId: event.requestId, patch: null, error: (error as Error).message });
      }
    }
    case "git.discard": {
      const source = store.projects.get(event.projectId);
      const project = source ? { ...source, path: workspacePath(source.id, event.threadId) } : undefined;
      if (!project) return;
      await git.discard(project.path, event.path);
      await refreshGit(event.projectId, true, event.threadId);
      bus.emit({ t: "toast", level: "info", text: `Discarded changes in ${event.path}` });
      return;
    }
    case "git.commit": {
      const source = store.projects.get(event.projectId);
      const project = source ? { ...source, path: workspacePath(source.id, event.threadId) } : undefined;
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
      return;
    }
    case "file.tree": {
      const source = store.projects.get(event.projectId);
      const project = source ? { ...source, path: workspacePath(source.id, event.threadId) } : undefined;
      const entries = project ? await files.tree(project.path, event.path ?? "") : [];
      return send({ t: "file.tree", requestId: event.requestId, entries });
    }
    case "file.read": {
      const source = store.projects.get(event.projectId);
      const project = source ? { ...source, path: workspacePath(source.id, event.threadId) } : undefined;
      const content = project ? await files.read(project.path, event.path) : null;
      return send({ t: "file.content", requestId: event.requestId, path: event.path, content });
    }
    case "term.open": {
      const source = store.projects.get(event.projectId);
      const project = source ? { ...source, path: workspacePath(source.id, event.threadId) } : undefined;
      if (!project) return;
      if (!panelList().some((panel) => panel.id === event.termId && panel.kind === "terminal" && panel.projectId === project.id)) throw new Error("This terminal tab is closed");
      await terminals.open(event.termId, workspacePath(project.id, panelList().find((panel) => panel.id === event.termId)?.threadId), event.cols, event.rows);
      send({ t: "term.data", termId: event.termId, data: terminals.read(event.termId), reset: true });
      return;
    }
    case "term.data":
      await terminals.write(event.termId, event.data);
      return;
    case "term.resize":
      await terminals.resize(event.termId, event.cols, event.rows);
      return;
    case "term.close":
      await terminals.close(event.termId);
      return;
  }
}

const server = createServer(async (req, res) => {
  const url = req.url ?? "/";
  if (!url.startsWith("/mcp/") && !authorizeRemote(req)) { res.writeHead(401).end(); return; }
  if (remoteId && url === "/api/remote/shutdown" && req.method === "POST") {
    if (activeWork()) { res.writeHead(409).end("Finish remote tasks before updating this environment."); return; }
    res.writeHead(204).end();
    void shutdown();
    return;
  }
  if (["/api/updates/prepare", "/api/updates/cancel"].includes(url) && req.method === "POST") {
    if (!authorizeDesktop(String(req.headers["x-citropy-desktop-token"] || ""))) { res.writeHead(403).end(); return; }
    if (url.endsWith("/cancel")) { unlockAppUpdate(); res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ready: false })); return; }
    try {
      if (activeWork())
        throw new Error("Finish active conversations, updates, and Git operations before applying the update.");
      if (computerState().status !== "idle") throw new Error("End computer use before restarting to apply the update.");
      store.flush();
      lockForAppUpdate();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ready: true }));
    } catch (error) {
      res.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ error: (error as Error).message }));
    }
    return;
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method || "GET")) {
    try { assertApplicationReady(); } catch (error) {
      res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: (error as Error).message }));
      return;
    }
    activeRequests.add(req);
    const done = () => { activeRequests.delete(req); res.off("finish", done); res.off("close", done); };
    res.once("finish", done);
    res.once("close", done);
  }
  if (await handleFeatures(req, res, providerInfo, () => refreshProviders(true))) return;

  if (url.startsWith("/mcp/")) {
    const threadId = url.slice(5).split("?")[0] ?? "";
    await handleMcp(threadId, req, res);
    return;
  }

  if (url === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        app: "citropy",
        ...(remoteId ? { environmentId: remoteId, build: process.env.CITROPY_REMOTE_BUILD, protocol: 1 } : {}),
        development: dev,
        providers: providerInfo,
      }),
    );
    return;
  }

  if (
    ["/api/desktop", "/api/desktop?development=1"].includes(url) &&
    req.method === "POST"
  ) {
    if (url.endsWith("development=1") && !dev) {
      res.writeHead(403, { "content-type": "text/plain" }).end("Development tools are unavailable in this build. Run npm run desktop:dev from a source checkout.");
      return;
    }
    if (
      req.headers.origin &&
      req.headers.origin !== origin &&
      !(dev && req.headers.origin === developmentOrigin)
    ) {
      res.writeHead(403).end();
      return;
    }
    try {
      if (url.endsWith("development=1")) await startDevelopment();
      await openDesktop();
      res.writeHead(204).end();
    } catch (error) {
      res
        .writeHead(500, { "content-type": "text/plain" })
        .end((error as Error).message);
    }
    return;
  }

  if (dev && !url.startsWith("/api/")) {
    res
      .writeHead(302, {
        location: `${developmentOrigin}${url.startsWith("/") && !url.startsWith("//") ? url : "/"}`,
      })
      .end();
    return;
  }

  if (!serveStatic(distDir, url, res)) {
    res.writeHead(404).end("not found");
  }
});

const wss = new WebSocketServer({
  server,
  path: "/socket",
  maxPayload: 2 * 1024 * 1024,
  verifyClient: ({ origin: requestOrigin, req }: { origin: string; req: IncomingMessage }) => {
    if (!authorizeRemote(req)) return false;
    const desktopToken = new URL(req.url ?? "/socket", origin).searchParams.get("desktop");
    if (desktopToken !== null) return authorizeDesktop(desktopToken) && !requestOrigin;
    if (!requestOrigin) return true;
    const address = server.address();
    const localPort = typeof address === "object" && address ? address.port : port;
    const allowed = new Set([origin, `http://127.0.0.1:${localPort}`, `http://localhost:${localPort}`]);
    if (dev) allowed.add(developmentOrigin);
    return allowed.has(requestOrigin) && Boolean(req.headers.host);
  },
});

wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
  if (new URL(req.url ?? "/socket", origin).searchParams.has("desktop")) { attachDesktop(socket); return; }
  const consumer = randomUUID();
  const subscriptions = new Map<string, { pending: number; flow: boolean; streamId: string }>();
  const send = (event: ServerEvent) => {
    if (event.t === "term.data") {
      const subscription = subscriptions.get(event.termId);
      if (!subscription) return;
      if (subscription.flow) {
        subscription.pending += event.data.length;
        event = { ...event, streamId: subscription.streamId };
        if (subscription.pending > 131_072) terminals.flow(event.termId, consumer, true);
      }
    }
    if (socket.bufferedAmount > 1024 * 1024) { socket.close(1013, "The connection fell behind. Reconnecting."); return; }
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
  };
  const query = new URL(req.url ?? "/socket", origin).searchParams;
  const replay = query.get("epoch") === connectionEpoch ? eventJournal.replay(Number(query.get("after"))) : null;
  if (replay) {
    for (const event of replay) send(event);
    send({ t: "reconnected", epoch: connectionEpoch, sequence: eventJournal.sequence, shells: shellList(), browsers: browser.browserStates(), computer: computerState() });
  } else send({ t: "hello", snapshot: snapshot(), epoch: connectionEpoch, sequence: eventJournal.sequence });
  for (const project of store.projects.values()) void refreshGit(project.id, true);

  const unsubscribe = bus.subscribe(send);
  socket.on("message", async (raw) => {
    let event: ClientEvent;
    try {
      event = JSON.parse(String(raw)) as ClientEvent;
      if (!event || typeof event !== "object") return;
    } catch {
      return;
    }
    if (event.t === "term.ack") {
      const subscription = subscriptions.get(event.termId);
      if (subscription?.flow && subscription.streamId === event.streamId && Number.isSafeInteger(event.count) && event.count > 0 && event.count <= 1024 * 1024) {
        subscription.pending = Math.max(0, subscription.pending - event.count);
        if (subscription.pending < 32_768) terminals.flow(event.termId, consumer, false);
      }
      return;
    }
    if (event.t === "term.unsubscribe") { subscriptions.delete(event.termId); terminals.flow(event.termId, consumer, false); return; }
    if (event.t === "term.open") {
      terminals.flow(event.termId, consumer, false);
      subscriptions.set(event.termId, { pending: 0, flow: event.flowControl === true, streamId: randomUUID() });
    }
    try {
      assertApplicationReady();
      activeCommands++;
      try {
        if ("requestId" in event && event.requestId) {
          const replies = await eventJournal.request(event.requestId, event, async () => {
            const events: ServerEvent[] = [];
            await handle(event, reply => events.push(reply));
            return events;
          });
          for (const reply of replies) send(reply);
        } else await handle(event, send);
      } finally { activeCommands--; }
    } catch (error) {
      if ("requestId" in event && event.requestId)
        send({ t: "request.error", requestId: event.requestId, error: (error as Error).message });
      else send({ t: "toast", level: "error", text: (error as Error).message });
    }
  });
  socket.on("close", () => { unsubscribe(); terminals.release(consumer); });
});

desktopEvents.on("event", (event) => {
  if (event.type === "update.available" && typeof event.version === "string") notifyUpdateAvailable("Citropy", event.version, "Application");
});

let stopProviderUpdateChecks: (() => void) | undefined;
const providerTimer = setInterval(() => {
  if (wss.clients.size) void refreshProviders();
}, 60_000);
providerTimer.unref();

const gitTimer = setInterval(() => {
  store.wakeThreads();
  for (const thread of store.threads.values()) if (thread.running) void refreshGit(thread.projectId, false, thread.id);
}, 1800);
gitTimer.unref();

server.listen(port, host, async () => {
  if (dev) {
    try {
      await startDevelopment();
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exit(1);
    }
  }
  await terminals.restore();
  await refreshProviders();
  stopProviderUpdateChecks = startProviderUpdateChecks();
  process.send?.({ t: "ready" });
  const available = providerInfo.filter((entry) => entry.available).map((entry) => entry.label);
  process.stdout.write(`\n  Citropy listening on ${origin}\n`);
  process.stdout.write(`  providers: ${available.join(", ") || "none detected"}\n`);
  if (dev) {
    process.stdout.write(`  ui (dev): ${developmentOrigin}\n\n`);
  } else {
    process.stdout.write(`  open ${origin} in a browser\n\n`);
  }
});

server.on("error", (error) => {
  process.stderr.write(`\n  Citropy could not start: ${(error as Error).message}\n\n`);
  process.exit(1);
});

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  clearInterval(providerTimer);
  stopProviderUpdateChecks?.();
  clearInterval(gitTimer);
  disposeAll();
  terminals.detach();
  store.flush();
  await stopComputer();
  await Promise.all([browser.closeBrowsers(), waitForStoppedProcesses()]);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
