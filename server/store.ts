import { dataRoot } from "./paths.ts";
import { dev } from "./config.ts";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync, renameSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, basename, resolve } from "node:path";
import { bus } from "./bus.ts";
import { eventJournal } from "./event-journal.ts";
import { removeToolImages } from "./tool-images.ts";
import { uid } from "./ids.ts";
import { subagentFinishedNotification } from "./subagent-notifications.ts";
import { emptyUsage } from "../shared/protocol.ts";
import { normalizeTodos } from "../shared/todos.ts";
import { defaultAssistance, gitActionBusy, type AssistanceSettings } from "../shared/assistance.ts";
import type {
  ProviderId,
  Message,
  Part,
  Project,
  ProjectSettings,
  Thread,
  ThreadMeta,
  Usage,
  AppNotification,
  NotificationPreferences,
} from "../shared/protocol.ts";

const root = dataRoot;
const legacyRoots = [join(homedir(), ".citropy-lemon"), join(homedir(), ".loom")];
if (!dev && !process.env.CITROPY_DATA_DIR && !existsSync(root)) {
  for (const legacy of legacyRoots) {
    if (!existsSync(legacy)) continue;
    try {
      renameSync(legacy, root);
    } catch {
      // the older build can still hold its folder open on Windows
    }
    break;
  }
}
const threadsDir = join(root, "threads");
const settingsFile = join(root, "settings.json");
const projectsFile = join(root, "projects.json");
const notificationsFile = join(root, "notifications.json");

mkdirSync(threadsDir, { recursive: true });

let writes = 0;
let skipped = 0;

export function persistenceStats(): { writes: number; skipped: number } {
  return { writes, skipped };
}

function save(path: string, value: unknown, durable = true): void {
  saveRaw(path, JSON.stringify(value), durable);
}

function saveRaw(path: string, json: string, durable: boolean): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, json, { flag: "wx", mode: 0o600, ...(durable ? { flush: true } : {}) });
    renameSync(temporary, path);
    writes += 1;
  } finally {
    rmSync(temporary, { force: true });
  }
}

function meta(thread: Thread): ThreadMeta {
  const { messages, ...rest } = thread;
  const paths = new Set<string>();
  for (const message of messages) for (const part of message.parts) {
    if (part.kind !== "tool" || part.status !== "ok" || !["edit", "write"].includes(part.shape)) continue;
    const input = part.input as Record<string, unknown> | undefined;
    const candidates = Array.isArray(input?.paths) ? input.paths : [input?.file_path ?? input?.filePath ?? input?.path];
    for (const path of candidates) if (typeof path === "string" && path) paths.add(path);
  }
  return { ...rest, updatedAt: messages.at(-1)?.ts ?? rest.updatedAt, changedFiles: paths.size };
}

export class Store {
  projects = new Map<string, Project>();
  threads = new Map<string, Thread>();
  disabledProviders = new Set<ProviderId>();
  computerEnabled = false;
  assistance: AssistanceSettings = { ...defaultAssistance };
  projectDefaults: ProjectSettings = {};
  notifications: AppNotification[] = [];
  notificationPreferences: NotificationPreferences = {
    toasts: true,
    desktop: true,
    sound: false,
  };
  #dirty = new Set<string>();
  #flushTimer: NodeJS.Timeout | null = null;
  #savedProjects = "";
  #lastSize = new Map<string, number>();
  #hashes = new Map<string, string>();
  #durable = new Set<string>();

  constructor() {
    this.#load();
    eventJournal.importThreads(this.threads.values());
    this.threads = new Map(eventJournal.threads().map(thread => {
      const original = JSON.stringify(thread);
      const interrupted = thread.running || thread.compacting;
      if (gitActionBusy(thread.gitAction)) thread.gitAction = { ...thread.gitAction!, status: "error", message: "Citropy restarted during the Git action. Check source control before retrying." };
      thread.running = false;
      thread.compacting = false;
      thread.activeTool = undefined;
      if (interrupted) { thread.status = "stopped"; thread.error = "Citropy restarted before this turn finished. Your conversation was recovered."; }
      for (const message of thread.messages) for (const part of message.parts) {
        if (part.kind === "question" && part.status === "pending") part.status = "dismissed";
        if (part.kind === "todo") part.items = normalizeTodos(part.items);
        if (part.kind === "text" || part.kind === "reasoning") part.complete = true;
        if (part.kind === "tool" && part.status === "running") { part.status = "error"; part.output ||= "The provider stopped before returning a tool result."; }
      }
      if (JSON.stringify(thread) !== original) {
        const { messages, ...meta } = thread;
        eventJournal.append({ t: "thread.upsert", thread: meta });
        eventJournal.append({ t: "thread.messages", threadId: thread.id, messages });
      }
      return [thread.id, thread];
    }));
  }

  #load(): void {
    if (existsSync(settingsFile)) {
      try {
        const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
        if (settings.projectDefaults && typeof settings.projectDefaults === "object" && !Array.isArray(settings.projectDefaults))
          this.projectDefaults = settings.projectDefaults;
        this.computerEnabled = settings.computerEnabled === true;
        if (typeof settings.assistance?.automaticTitles === "boolean") this.assistance.automaticTitles = settings.assistance.automaticTitles;
        for (const key of ["titleModel", "commitModel", "reviewModel"] as const) {
          const model = settings.assistance?.[key];
          if (model && ["claude", "codex", "opencode", "cursor"].includes(model.provider) && typeof model.model === "string" && model.model.trim())
            this.assistance[key] = { provider: model.provider, model: model.model };
        }
        for (const key of ["toasts", "desktop", "sound"] as const) {
          if (typeof settings.notifications?.[key] === "boolean")
            this.notificationPreferences[key] = settings.notifications[key];
        }
        if (Array.isArray(settings.disabledProviders)) {
          for (const id of settings.disabledProviders) {
            if (["claude", "codex", "opencode", "cursor"].includes(id)) this.disabledProviders.add(id);
          }
        }
      } catch (error) {
        process.stderr.write(
          `Could not load provider settings: ${String(error)}\n`,
        );
      }
    }
    if (existsSync(notificationsFile)) {
      try {
        const entries = JSON.parse(readFileSync(notificationsFile, "utf8"));
        if (Array.isArray(entries))
          this.notifications = entries
            .filter(
              (entry) =>
                typeof entry.id === "string" &&
                typeof entry.title === "string" &&
                typeof entry.text === "string" &&
                entry.target &&
                typeof entry.createdAt === "number",
            )
            .slice(0, 100);
      } catch (error) {
        process.stderr.write(
          `Could not load notifications: ${String(error)}\n`,
        );
      }
    }
    if (existsSync(projectsFile)) {
      const raw = JSON.parse(readFileSync(projectsFile, "utf8")) as Project[];
      for (const project of raw) this.projects.set(project.id, project);
    }
    for (const name of readdirSync(threadsDir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const thread = JSON.parse(readFileSync(join(threadsDir, name), "utf8")) as Thread;
        if (thread.status !== "idle" && thread.status !== "error") thread.status = "idle";
        this.threads.set(thread.id, thread);
      } catch (error) {
        process.stderr.write(`Could not load saved conversation ${name}; the file was preserved: ${String(error)}\n`);
      }
    }
  }

  #schedule(threadId: string): void {
    this.#dirty.add(threadId);
    if (this.#flushTimer) return;
    const bytes = this.#lastSize.get(threadId) ?? 0;
    const delay = Math.min(5000, Math.max(400, 400 + (bytes / 1_000_000) * 600));
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.#flushScheduled();
    }, delay);
    this.#flushTimer.unref();
  }

  #persistThread(id: string, durable: boolean): void {
    const thread = this.threads.get(id);
    if (!thread) return;
    const json = JSON.stringify(thread);
    this.#lastSize.set(id, Buffer.byteLength(json));
    const hash = createHash("sha1").update(json).digest("hex");
    // A scheduled write skips fsync, so a durable flush still rewrites once even when unchanged.
    if (this.#hashes.get(id) === hash && (!durable || this.#durable.has(id))) {
      skipped += 1;
      return;
    }
    saveRaw(join(threadsDir, `${id}.json`), json, durable);
    this.#hashes.set(id, hash);
    if (durable) this.#durable.add(id);
    else this.#durable.delete(id);
  }

  #flushScheduled(): void {
    for (const id of this.#dirty) this.#persistThread(id, false);
    this.#dirty.clear();
  }

  flush(): void {
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
    for (const id of this.#dirty) this.#persistThread(id, true);
    this.#dirty.clear();
    const projects = [...this.projects.values()];
    const serialized = JSON.stringify(projects);
    if (serialized !== this.#savedProjects) {
      save(projectsFile, projects);
      this.#savedProjects = serialized;
    }
  }

  setProviderEnabled(id: ProviderId, enabled: boolean): void {
    if (!["claude", "codex", "opencode", "cursor"].includes(id) || typeof enabled !== "boolean") throw new Error("Invalid provider setting");
    const disabled = new Set(this.disabledProviders);
    if (enabled) disabled.delete(id);
    else disabled.add(id);
    save(settingsFile, {
      disabledProviders: [...disabled],
      notifications: this.notificationPreferences,
      computerEnabled: this.computerEnabled,
      assistance: this.assistance,
      projectDefaults: this.projectDefaults,
    });
    this.disabledProviders = disabled;
  }

  setComputerEnabled(enabled: boolean): void {
    save(settingsFile, {
      disabledProviders: [...this.disabledProviders],
      notifications: this.notificationPreferences,
      computerEnabled: enabled,
      assistance: this.assistance,
      projectDefaults: this.projectDefaults,
    });
    this.computerEnabled = enabled;
  }

  notify(input: Omit<AppNotification, "id" | "createdAt" | "read">): void {
    const notification: AppNotification = {
      ...input,
      id: uid("ntf"),
      createdAt: Date.now(),
      read: false,
    };
    this.notifications = [notification, ...this.notifications].slice(0, 100);
    save(notificationsFile, this.notifications);
    bus.emit({ t: "notification.add", notification });
  }

  readNotifications(ids?: string[]): void {
    if (
      ids !== undefined &&
      (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
    )
      throw new Error("Invalid notification selection");
    this.notifications = this.notifications.map((entry) =>
      !ids || ids.includes(entry.id) ? { ...entry, read: true } : entry,
    );
    save(notificationsFile, this.notifications);
    bus.emit({ t: "notifications.update", notifications: this.notifications });
  }

  clearNotifications(): void {
    this.notifications = this.notifications.filter((entry) => !entry.read);
    save(notificationsFile, this.notifications);
    bus.emit({ t: "notifications.update", notifications: this.notifications });
  }

  configureNotifications(patch: Partial<NotificationPreferences>): void {
    if (
      !patch ||
      Object.entries(patch).some(
        ([key, value]) =>
          !["toasts", "desktop", "sound"].includes(key) ||
          typeof value !== "boolean",
      )
    )
      throw new Error("Invalid notification preferences");
    const preferences = { ...this.notificationPreferences, ...patch };
    save(settingsFile, {
      disabledProviders: [...this.disabledProviders],
      notifications: preferences,
      computerEnabled: this.computerEnabled,
      assistance: this.assistance,
      projectDefaults: this.projectDefaults,
    });
    this.notificationPreferences = preferences;
    bus.emit({ t: "notifications.preferences", preferences });
  }

  configureAssistance(settings: AssistanceSettings): void {
    save(settingsFile, {
      disabledProviders: [...this.disabledProviders],
      notifications: this.notificationPreferences,
      computerEnabled: this.computerEnabled,
      assistance: settings,
      projectDefaults: this.projectDefaults,
    });
    this.assistance = settings;
    bus.emit({ t: "assistance.settings", settings });
  }

  configureProjectDefaults(settings: ProjectSettings): void {
    save(settingsFile, {
      disabledProviders: [...this.disabledProviders],
      notifications: this.notificationPreferences,
      computerEnabled: this.computerEnabled,
      assistance: this.assistance,
      projectDefaults: settings,
    });
    this.projectDefaults = settings;
    bus.emit({ t: "project.defaults", settings });
  }

  openProject(path: string): Project {
    const abs = resolve(path.replace(/^~(?=$|[/\\])/, homedir()));
    const existing = [...this.projects.values()].find((p) => p.path === abs);
    if (existing) {
      existing.lastOpened = Date.now();
      bus.emit({ t: "project.upsert", project: existing });
      this.flush();
      return existing;
    }
    const project: Project = {
      id: uid("prj"),
      path: abs,
      name: basename(abs) || abs,
      isGit: existsSync(join(abs, ".git")),
      lastOpened: Date.now(),
    };
    this.projects.set(project.id, project);
    bus.emit({ t: "project.upsert", project });
    this.flush();
    return project;
  }

  updateProject(id: string, patch: Pick<Partial<Project>, "name" | "settings">): Project {
    const project = this.projects.get(id);
    if (!project) throw new Error("Workspace not found");
    Object.assign(project, patch);
    this.flush();
    bus.emit({ t: "project.upsert", project });
    return project;
  }

  closeProject(id: string): void {
    this.projects.delete(id);
    for (const thread of [...this.threads.values()]) {
      if (thread.projectId === id) this.removeThread(thread.id);
    }
    bus.emit({ t: "project.remove", id });
    this.flush();
  }

  createThread(input: Omit<ThreadMeta, "id" | "createdAt" | "updatedAt" | "status" | "usage" | "running">): Thread {
    if (this.disabledProviders.has(input.provider)) throw new Error("This provider is disabled. Enable it in Settings > Providers.");
    const now = Date.now();
    const thread: Thread = {
      ...input,
      ...(input.parentThreadId ? { parentMessageId: this.threads.get(input.parentThreadId)?.messages.findLast((message) => message.role === "user")?.id } : {}),
      id: uid("thr"),
      createdAt: now,
      updatedAt: now,
      status: "idle",
      usage: emptyUsage(),
      running: false,
      messages: [],
    };
    this.threads.set(thread.id, thread);
    bus.emit({ t: "thread.upsert", thread: meta(thread) });
    this.#schedule(thread.id);
    return thread;
  }

  removeThread(id: string): void {
    if (!this.threads.has(id)) return;
    for (const child of [...this.threads.values()]) {
      if (child.parentThreadId === id) this.removeThread(child.id);
    }
    this.threads.delete(id);
    this.#dirty.delete(id);
    this.#lastSize.delete(id);
    this.#hashes.delete(id);
    this.#durable.delete(id);
    const remaining = this.notifications.filter((entry) => entry.target.threadId !== id);
    if (remaining.length !== this.notifications.length) {
      this.notifications = remaining;
      save(notificationsFile, this.notifications);
      bus.emit({ t: "notifications.update", notifications: this.notifications });
    }
    rmSync(join(threadsDir, `${id}.json`), { force: true });
    rmSync(join(root, "attachments", id), { recursive: true, force: true });
    removeToolImages(id);
    rmSync(join(root, "transfers", id), { recursive: true, force: true });
    rmSync(join(root, "checkpoints", `${id}-redo.json`), { force: true });
    bus.emit({ t: "thread.remove", id });
  }

  setThreadFinished(id: string, finished: boolean): void {
    if (typeof finished !== "boolean") throw new Error("Invalid conversation state");
    const thread = this.threads.get(id);
    if (!thread) return;
    if (finished && (thread.running || thread.status === "awaiting")) throw new Error("Stop this conversation before finishing it.");
    if (finished && [...this.threads.values()].some((child) => child.parentThreadId === id && child.running)) throw new Error("Wait for this conversation's subagents to finish first.");
    thread.finished = finished;
    thread.snoozedUntil = undefined;
    if (finished) thread.pinned = false;
    bus.emit({ t: "thread.upsert", thread: meta(thread) });
    this.#schedule(id);
  }

  organizeThread(id: string, patch: Pick<Partial<ThreadMeta>, "title" | "pinned" | "position" | "snoozedUntil" | "archived" | "pullRequest">): void {
    const thread = this.threads.get(id);
    if (!thread) throw new Error("Conversation not found");
    if ((patch.archived || patch.snoozedUntil) && (thread.running || [...this.threads.values()].some((child) => child.parentThreadId === id && child.running))) throw new Error("Stop this conversation and its subagents before putting it away.");
    this.patchThread(id, { ...patch, ...(patch.pinned ? { finished: false, archived: false, snoozedUntil: undefined } : {}) });
  }

  wakeThreads(): void {
    for (const thread of this.threads.values()) if (thread.snoozedUntil && thread.snoozedUntil <= Date.now()) this.patchThread(thread.id, { snoozedUntil: undefined });
  }

  patchThread(id: string, patch: Partial<ThreadMeta>): void {
    const thread = this.threads.get(id);
    if (!thread) return;
    const finished = thread.parentThreadId && thread.running && patch.running === false && patch.status !== "stopped";
    if (!thread.running && patch.running) thread.runCount = (thread.runCount ?? 0) + 1;
    Object.assign(thread, patch);
    thread.updatedAt = Date.now();
    bus.emit({ t: "thread.upsert", thread: meta(thread) });
    this.#schedule(id);
    if (finished) {
      const notification = subagentFinishedNotification(thread);
      if (!this.notifications.some((entry) => entry.dedupeKey === notification.dedupeKey)) this.notify(notification);
    }
  }

  updateSubagent(parentId: string, update: { id: string; title?: string; prompt?: string; model?: string; status: ThreadMeta["status"]; result?: string }): void {
    const parent = this.threads.get(parentId);
    if (!parent) return;
    let child = [...this.threads.values()].find((entry) => entry.parentThreadId === parentId && entry.nativeAgentId === update.id);
    if (!child) {
      child = this.createThread({ projectId: parent.projectId, provider: parent.provider, workspacePath: parent.workspacePath, workspaceBranch: parent.workspaceBranch, parentThreadId: parentId, nativeAgentId: update.id, title: update.title || "Subagent", model: update.model ?? parent.model, permissionMode: parent.permissionMode });
      if (update.prompt) this.addMessage(child.id, { id: uid("msg"), ts: Date.now(), role: "user", parts: [{ id: uid("prt"), kind: "text", text: update.prompt }] });
    }
    if (update.result) {
      const previous = child.messages.at(-1);
      if (previous?.role === "assistant" && previous.parts[0]?.kind === "text") {
        this.patchPart(child.id, previous.id, previous.parts[0].id, { text: update.result });
      } else {
        this.addMessage(child.id, { id: uid("msg"), ts: Date.now(), role: "assistant", model: child.model, parts: [{ id: uid("prt"), kind: "text", text: update.result }] });
      }
    }
    this.patchThread(child.id, { status: update.status, running: ["queued", "thinking", "working", "awaiting"].includes(update.status), ...(update.title ? { title: update.title.slice(0, 80) } : {}), ...(update.model ? { model: update.model } : {}) });
  }

  setUsage(id: string, usage: Usage): void {
    this.patchThread(id, { usage });
  }

  addMessage(threadId: string, message: Message): Message {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`unknown thread ${threadId}`);
    if (message.role === "assistant") message.provider ??= thread.provider;
    thread.messages.push(message);
    thread.updatedAt = message.ts;
    bus.emit({ t: "message.add", threadId, message });
    this.#schedule(threadId);
    return message;
  }

  replaceMessages(threadId: string, messages: Message[]): void {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("Conversation not found.");
    thread.messages = messages;
    bus.emit({ t: "thread.messages", threadId, messages });
    this.#schedule(threadId);
  }

  addPart(threadId: string, messageId: string, part: Part): Part {
    const message = this.#message(threadId, messageId);
    message.parts.push(part);
    bus.emit({ t: "part.add", threadId, messageId, part });
    this.#schedule(threadId);
    return part;
  }

  appendText(threadId: string, messageId: string, partId: string, text: string): void {
    const part = this.#part(threadId, messageId, partId);
    if (part.kind === "text" || part.kind === "reasoning") part.text += text;
    bus.emit({ t: "part.append", threadId, messageId, partId, text });
    this.#schedule(threadId);
  }

  patchPart(threadId: string, messageId: string, partId: string, patch: Record<string, unknown>): void {
    const part = this.#part(threadId, messageId, partId);
    Object.assign(part, patch);
    bus.emit({ t: "part.patch", threadId, messageId, partId, patch });
    this.#schedule(threadId);
  }

  #message(threadId: string, messageId: string): Message {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`unknown thread ${threadId}`);
    const message = thread.messages.find((m) => m.id === messageId);
    if (!message) throw new Error(`unknown message ${messageId}`);
    return message;
  }

  #part(threadId: string, messageId: string, partId: string): Part {
    const part = this.#message(threadId, messageId).parts.find((p) => p.id === partId);
    if (!part) throw new Error(`unknown part ${partId}`);
    return part;
  }

  meta(thread: Thread): ThreadMeta {
    return meta(thread);
  }

  allMeta(): ThreadMeta[] {
    return [...this.threads.values()].map(meta);
  }
}

export const store = new Store();
