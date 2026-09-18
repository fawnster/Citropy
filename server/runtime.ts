import { assertApplicationReady } from "./update-lock.ts";
import { generateThreadTitle, workspaceGitBusy } from "./assistance.ts";
import { stopTextGeneration, textGenerationBusy } from "./text-generation.ts";
import { basename } from "node:path";
import { diffLines } from "./diff.ts";
import { uid } from "./ids.ts";
import { cancelQuestions, hasPendingQuestion } from "./questions.ts";
import { cancelThread } from "./permissions.ts";
import { store } from "./store.ts";
import { removeAttachment, validateAttachments } from "./assets.ts";
import { workspacePath } from "./workspaces.ts";
import { listSkills } from "./skills.ts";
import { expandCommand } from "./commands.ts";
import { describeTool } from "./tools.ts";
import { providers } from "./providers/index.ts";
import { receiveAgentEvent } from "./providers/events.ts";
import { beginCheckpoint, finishCheckpoint, checkpointBusy, historyPrompt } from "./checkpoints.ts";
import { prepareContext, prepareTransferContext, transferPrompt } from "./context.ts";
import { assertProviderReady } from "./providers/maintenance.ts";
import { modelSettings, selectedModel } from "../shared/model-options.ts";
import { emptyUsage } from "../shared/protocol.ts";
import { connectTools, disconnectTools } from "./mcp-access.ts";
import type { AgentEvent } from "./providers/types.ts";
import type { AgentSession } from "./providers/types.ts";
import { startShell, shellOutput, endShell, endThreadShells, shellList } from "./shells.ts";
import { waitForStoppedProcesses } from "./providers/process.ts";
import type {
  Message,
  Part,
  Thread,
  ToolPart,
  TodoPart,
  Attachment,
  QueuedMessage,
  ProviderInfo,
} from "../shared/protocol.ts";

const MAX_OUTPUT = 24_000;
const PLAN_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate", "TaskView"]);
const COMMAND = /^\/[\w.:-]+(?:\s|$)/;

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n… ${text.length - MAX_OUTPUT} more characters`;
}

interface PartRef {
  messageId: string;
  partId: string;
}

interface Prepared {
  messageId: string;
  contextSources: import("../shared/context.ts").ContextSource[];
  generation: number;
  text: string;
  attachments: Attachment[];
  prompt: string;
  skills: Array<{ name: string; path: string }>;
}

export class ThreadRuntime {
  #thread: Thread;
  #disposed = false;
  #session: AgentSession | null = null;
  #sessionGeneration = 0;
  #messageId: string | null = null;
  #blocks = new Map<string, PartRef>();
  #tools = new Map<string, PartRef>();
  #todo: PartRef | null = null;
  #running = new Set<string>();
  #pendingModel: string | undefined;
  #preparing = false;
  #checkpointCompletion: Promise<void> | null = null;
  #enqueuing: Promise<void> | undefined;
  #stopGeneration = 0;
  #resume = false;
  #compactionTimer: NodeJS.Timeout | undefined;
  #stopping: { promise: Promise<void>; ended: () => void; release: () => void } | null = null;

  constructor(thread: Thread) {
    this.#thread = thread;
  }

  get #cwd(): string {
    return workspacePath(this.#thread.projectId, this.#thread.id);
  }

  get id(): string {
    return this.#thread.id;
  }

  get busy(): boolean {
    return this.#preparing || Boolean(this.#enqueuing) || Boolean(this.#stopping) || Boolean(this.#checkpointCompletion) || this.#thread.running || this.#thread.status === "awaiting" || shellList().some(shell => shell.threadId === this.id && !shell.panelId && (shell.status === "running" || shell.status === "stopping"));
  }

  async send(text: string, files: Attachment[] = []): Promise<void> {
    if (typeof text === "string" && text.trim() === "/compact" && Array.isArray(files) && !files.length) return this.compact();
    if (this.#thread.compacting) throw new Error("Wait for context compaction to finish.");
    if (this.#preparing || this.#thread.running || this.#enqueuing) return this.#enqueue(text, files);
    this.#preparing = true;
    this.#resume = false;
    try { await this.#deliver(await this.#prepare(text, files)); }
    finally { this.#preparing = false; this.#pump(); }
  }

  async transfer(provider: ProviderInfo, modelId: string): Promise<void> {
    assertApplicationReady();
    assertProviderReady(provider.id);
    const thread = this.#thread;
    if (this.#disposed || this.busy || thread.compacting || thread.queue?.length)
      throw new Error("Wait for this conversation and its queued messages to finish before transferring.");
    if (thread.parentThreadId || thread.nativeAgentId || !thread.messages.length)
      throw new Error("Transfer is only available in an existing chat.");
    if ([...store.threads.values()].some(child => child.parentThreadId === this.id && (child.running || child.status === "awaiting")))
      throw new Error("Wait for this conversation's subagents to finish before transferring.");
    if (!provider.available || !provider.enabled || store.disabledProviders.has(provider.id))
      throw new Error("Select an enabled, installed provider.");
    const model = selectedModel(provider.models, modelId);
    if (!model) throw new Error("This model is no longer available. Refresh the model list.");
    if (provider.id === thread.provider && model.id === selectedModel(provider.models, thread.model)?.id)
      throw new Error("Choose another model for the transfer.");
    if (workspaceGitBusy(this.#cwd) || checkpointBusy(this.#cwd))
      throw new Error("Wait for workspace changes to finish before transferring.");
    this.#preparing = true;
    this.#resume = false;
    const generation = this.#stopGeneration;
    try {
      const context = await prepareTransferContext(thread);
      this.#checkSession(generation);
      assertApplicationReady();
      assertProviderReady(provider.id);
      if (store.disabledProviders.has(provider.id)) throw new Error("Enable this provider before transferring.");
      const previous = { provider: thread.provider, model: thread.model, externalId: thread.externalId, usage: { ...thread.usage }, at: Date.now() };
      this.#sessionGeneration += 1;
      this.#session?.dispose();
      this.#session = null;
      this.#pendingModel = undefined;
      this.#messageId = null;
      this.#blocks.clear();
      this.#tools.clear();
      this.#running.clear();
      this.#todo = null;
      cancelThread(this.id);
      cancelQuestions(this.id);
      disconnectTools(this.id);
      await waitForStoppedProcesses();
      this.#checkSession(generation);
      assertApplicationReady();
      assertProviderReady(provider.id);
      if (store.disabledProviders.has(provider.id)) throw new Error("Enable this provider before transferring.");
      store.replaceMessages(this.id, thread.messages.map(message => message.role === "assistant" ? { ...message, provider: message.provider ?? previous.provider, model: message.model ?? previous.model } : message));
      store.patchThread(this.id, {
        provider: provider.id,
        ...modelSettings(provider.models, { model: model.id }),
        externalId: undefined,
        usage: emptyUsage(),
        transfers: [...(thread.transfers ?? []), previous],
        transferContext: context,
        rebuildContext: false,
        contextSources: [],
        canRedo: false,
        compactedAt: undefined,
        error: undefined,
        status: "idle",
        activeTool: undefined,
      });
      const prepared = await this.#prepare(`Transfer to ${model.label} (${provider.label}) and continue the conversation.`, []);
      await this.#deliver(prepared);
    } finally {
      this.#preparing = false;
      this.#pump();
    }
  }

  async sendNow(id: string): Promise<void> {
    const queue = this.#thread.queue ?? [];
    const index = queue.findIndex((entry) => entry.id === id);
    if (index === -1) throw new Error("This message was already sent or removed.");
    const item = queue[index]!;
    if (!this.#thread.running && !this.#preparing) {
      store.patchThread(this.id, { queue: queue.filter((entry) => entry !== item) });
      return this.#sendQueued(item, index);
    }
    if (this.#thread.compacting) throw new Error("Wait for context compaction to finish.");
    if (COMMAND.test(item.text.trim())) throw new Error("Commands wait until the current run finishes.");
    const session = this.#session;
    if (!session || this.#preparing) throw new Error("Your last message is still on its way. Try again in a moment.");
    if (!session.steer) throw new Error(`${providers[this.#thread.provider].label} can't take a message until it finishes.`);
    this.#preparing = true;
    store.patchThread(this.id, { queue: queue.filter((entry) => entry !== item) });
    try {
      const prepared = await this.#prepare(item.text, item.attachments ?? []);
      this.#checkSession(prepared.generation);
      await session.steer(prepared.prompt, prepared.attachments, prepared.skills);
      this.#addUserMessage(prepared);
    } catch (error) {
      this.#requeue(item, index);
      throw error;
    } finally {
      this.#preparing = false;
      this.#pump();
    }
  }

  async removeQueued(id: string): Promise<void> {
    const item = this.takeQueued(id);
    await Promise.all((item.attachments ?? []).map((file) => removeAttachment(this.id, String(file.id))));
  }

  takeQueued(id: string): QueuedMessage {
    const queue = this.#thread.queue ?? [];
    const item = queue.find((entry) => entry.id === id);
    if (!item) throw new Error("This message was already sent or removed.");
    store.patchThread(this.id, { queue: queue.filter((entry) => entry !== item) });
    return item;
  }

  moveQueued(id: string, index: number): void {
    const queue = [...(this.#thread.queue ?? [])];
    const from = queue.findIndex((entry) => entry.id === id);
    if (from === -1) throw new Error("This message was already sent or removed.");
    if (!Number.isInteger(index) || index < 0 || index >= queue.length) throw new Error("Choose a position inside the queue.");
    queue.splice(index, 0, ...queue.splice(from, 1));
    store.patchThread(this.id, { queue });
  }

  #check(text: string, files: Attachment[]): void {
    if (this.#thread.nativeAgentId) throw new Error("This subagent is managed by its parent conversation.");
    if (typeof text !== "string" || text.length > 120_000 || (!text.trim() && !files.length)) throw new Error("Enter a message or attach a file.");
  }

  #enqueue(text: string, files: Attachment[]): Promise<void> {
    const pending = (this.#enqueuing ?? Promise.resolve()).then(async () => {
      this.#checkSession();
      this.#check(text, files);
      const attachments = await validateAttachments(this.id, files);
      this.#checkSession();
      store.patchThread(this.id, { queue: [...(this.#thread.queue ?? []), { id: uid("que"), text, attachments, createdAt: Date.now() }] });
    });
    const tail = pending.catch(() => {});
    this.#enqueuing = tail;
    void tail.then(() => {
      if (this.#enqueuing === tail) this.#enqueuing = undefined;
      this.#pump();
    });
    return pending;
  }

  #checkSession(generation = this.#stopGeneration): void {
    if (this.#disposed || !store.threads.has(this.id)) throw new Error("This conversation has closed.");
    if (generation !== this.#stopGeneration) throw new Error("This session has stopped. Send your message again.");
  }

  async #prepare(text: string, files: Attachment[]): Promise<Prepared> {
    assertApplicationReady();
    assertProviderReady(this.#thread.provider);
    const generation = this.#stopGeneration;
    if (this.#checkpointCompletion) await this.#checkpointCompletion;
    this.#checkSession(generation);
    if (checkpointBusy(this.#cwd)) throw new Error("Wait for workspace review or recovery to finish.");
    if (workspaceGitBusy(this.#cwd)) throw new Error("Wait for the Git action to finish before sending a message.");
    this.#check(text, files);
    if (this.#thread.compacting) throw new Error("Wait for context compaction to finish.");
    const attachments = await validateAttachments(this.id, files);
    let prompt = await expandCommand(this.#thread.provider, text);
    const context = await prepareContext(this.#thread, prompt);
    prompt = context.prompt;
    if (this.#thread.transferContext) prompt = `${await transferPrompt(this.#thread.transferContext)}\n\nCurrent request:\n${prompt}`;
    else if (this.#thread.rebuildContext && !this.#thread.externalId) prompt = historyPrompt(this.#thread.messages, prompt);
    const names = new Set([...text.matchAll(/(?:^|\s)[@$]([\w.:-]+)(?![\w./:-])/g)].map((match) => match[1]));
    const skills = names.size ? (await listSkills(this.#thread.projectId, this.id)).filter((skill) => skill.enabled && skill.provider === this.#thread.provider && names.has(skill.name)).sort((a, b) => Number(b.scope === "project") - Number(a.scope === "project")).filter((skill, index, entries) => entries.findIndex((entry) => entry.name === skill.name) === index) : [];
    this.#checkSession(generation);
    if (store.disabledProviders.has(this.#thread.provider)) throw new Error("This provider is disabled. Enable it in Settings > Providers.");
    assertApplicationReady();
    assertProviderReady(this.#thread.provider);
    return { messageId: uid("msg"), contextSources: context.sources, generation, text, attachments, prompt, skills };
  }

  #addUserMessage({ messageId, text, attachments, contextSources }: Prepared): void {
    if (this.#thread.finished) store.setThreadFinished(this.#thread.id, false);
    const message: Message = {
      id: messageId,
      role: "user",
      parts: [{ id: uid("prt"), kind: "text", text }],
      ts: Date.now(),
      attachments,
      contextSources,
    };
    store.addMessage(this.#thread.id, message);
    store.patchThread(this.id, { contextSources });
    if (!this.#thread.title || this.#thread.title === "New thread") {
      const title = (text.trim().split("\n")[0] || attachments.map((file) => file.label).join(", ")).slice(0, 64);
      store.patchThread(this.#thread.id, { title: title || "New thread" });
      void generateThreadTitle(this.id, true);
    }
    this.#messageId = null;
  }

  async #deliver(prepared: Prepared, queued?: { item: QueuedMessage; index: number }): Promise<void> {
    try {
      if (this.#stopping) await this.#stopping.promise;
      this.#checkSession(prepared.generation);
    }
    catch (error) {
      if (queued) this.#requeue(queued.item, queued.index);
      throw error;
    }
    if (workspaceGitBusy(this.#cwd)) {
      if (queued) this.#requeue(queued.item, queued.index);
      throw new Error("Wait for the Git action to finish before sending a message.");
    }
    await beginCheckpoint(this.#thread, prepared.messageId);
    this.#checkSession(prepared.generation);
    this.#addUserMessage(prepared);
    if (this.#thread.canRedo) store.patchThread(this.id, { canRedo: false });
    store.patchThread(this.#thread.id, { status: "queued", running: true, runStartedAt: Date.now(), error: undefined, archived: false, snoozedUntil: undefined });
    try { await this.#ensureSession().send(prepared.prompt, prepared.attachments, prepared.skills); }
    catch (error) {
      if (!this.#disposed && prepared.generation === this.#stopGeneration) {
        this.#resume = false;
        store.patchThread(this.id, { status: "error", running: false, error: (error as Error).message });
      }
      throw error;
    }
  }

  #pump(): void {
    if (!this.#resume || this.#preparing || this.#checkpointCompletion || this.#thread.running || this.#disposed) return;
    const [next, ...rest] = this.#thread.queue ?? [];
    if (!next) return;
    store.patchThread(this.id, { queue: rest });
    void this.#sendQueued(next, 0);
  }

  async #sendQueued(item: QueuedMessage, index: number): Promise<void> {
    this.#preparing = true;
    const generation = this.#stopGeneration;
    try {
      const prepared = await this.#prepare(item.text, item.attachments ?? []).catch((error: Error) => {
        this.#requeue(item, index);
        throw error;
      });
      await this.#deliver(prepared, { item, index });
    } catch (error) {
      this.#resume = false;
      if (!this.#disposed && generation === this.#stopGeneration)
        store.patchThread(this.id, { status: "error", running: false, error: (error as Error).message });
    } finally {
      this.#preparing = false;
      this.#pump();
    }
  }

  #requeue(item: QueuedMessage, index: number): void {
    const queue = [...(this.#thread.queue ?? [])];
    queue.splice(index, 0, item);
    store.patchThread(this.id, { queue });
  }

  async compact(): Promise<void> {
    assertApplicationReady();
    assertProviderReady(this.#thread.provider);
    if (this.#disposed || this.#preparing || this.#stopping || this.#thread.running || this.#thread.nativeAgentId) throw new Error("Wait for the conversation to finish before compacting.");
    if (!this.#thread.externalId) throw new Error("Send a message before compacting this conversation.");
    if (store.disabledProviders.has(this.#thread.provider)) throw new Error("Enable this provider before compacting.");
    const generation = this.#stopGeneration;
    const session = this.#ensureSession();
    if (!session.compact) throw new Error("This provider does not support manual compaction.");
    store.patchThread(this.id, { compacting: true, status: "working", running: true, runStartedAt: Date.now(), activeTool: "Compacting context" });
    this.#compactionTimer = setTimeout(() => {
      if (!this.#thread.compacting) return;
      this.stop();
      store.patchThread(this.id, { status: "error", error: "The provider did not finish compaction within five minutes. Try again when it is ready." });
    }, 300_000);
    this.#compactionTimer.unref();
    try { await session.compact(); }
    catch (error) {
      clearTimeout(this.#compactionTimer);
      if (this.#disposed || generation !== this.#stopGeneration || this.#thread.status === "stopped") return;
      store.patchThread(this.id, { compacting: false, status: "error", running: false, activeTool: undefined, error: (error as Error).message });
      throw error;
    }
  }

  stop(): void {
    clearTimeout(this.#compactionTimer);
    this.#stopGeneration += 1;
    this.#resume = false;
    stopChildren(this.#thread.id);
    cancelThread(this.#thread.id);
    cancelQuestions(this.#thread.id);
    const active = this.#thread.running || this.#thread.compacting;
    store.patchThread(this.#thread.id, { status: "stopped", running: false, compacting: false, activeTool: undefined });
    if (this.#session && active && !this.#stopping) this.#waitForStop(this.#session);
  }

  #waitForStop(session: AgentSession): void {
    let ended!: () => void;
    const end = new Promise<void>(resolve => { ended = resolve; });
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    const stopping = { promise, ended, release: () => {
      clearTimeout(timer);
      if (this.#stopping === stopping) this.#stopping = null;
      release();
    } };
    const restart = () => {
      if (this.#session === session) {
        this.#sessionGeneration += 1;
        this.#session = null;
        session.dispose();
        disconnectTools(this.id);
        this.#finishParts();
      }
      stopping.release();
    };
    const timer = setTimeout(restart, 5000);
    this.#stopping = stopping;
    try {
      void Promise.all([end, session.interrupt()]).then(stopping.release, restart);
    } catch { restart(); }
  }

  dispose(preserveStatus = false): void {
    clearTimeout(this.#compactionTimer);
    this.#disposed = true;
    this.#stopping?.release();
    this.#sessionGeneration += 1;
    endThreadShells(this.id, "stopped");
    this.#finishParts();
    disconnectTools(this.#thread.id);
    if (!preserveStatus) store.patchThread(this.#thread.id, { status: "stopped", running: false, compacting: false, activeTool: undefined });
    cancelThread(this.#thread.id);
    cancelQuestions(this.#thread.id);
    this.#session?.dispose();
    this.#session = null;
  }

  #ensureSession(): AgentSession {
    if (this.#session) return this.#session;
    const provider = providers[this.#thread.provider];
    const project = store.projects.get(this.#thread.projectId);
    if (!project) throw new Error(`thread ${this.#thread.id} has no project`);
    store.patchThread(
      this.#thread.id,
      modelSettings(provider.models, this.#thread),
    );
    const generation = ++this.#sessionGeneration;
    this.#session = provider.start({
      mcp: connectTools(this.#thread.id),
      threadId: this.#thread.id,
      cwd: this.#cwd,
      model: this.#thread.model,
      effort: this.#thread.effort,
      contextMax: this.#thread.contextWindow,
      fastMode: this.#thread.fastMode,
      fastModeTier: provider.models.find((model) => model.id === this.#thread.model)?.fastModeTier,
      permissionMode: this.#thread.permissionMode,
      externalId: this.#thread.externalId,
      usage: { ...this.#thread.usage },
      emit: (event) => {
        if (generation !== this.#sessionGeneration) return;
        const validated = receiveAgentEvent(this.#thread.provider, this.id, event);
        if (validated) this.#consume(validated);
      },
    });
    return this.#session;
  }

  #message(): string {
    if (this.#messageId) return this.#messageId;
    const message: Message = {
      id: uid("msg"),
      role: "assistant",
      parts: [],
      ts: Date.now(),
      model: this.#pendingModel ?? this.#thread.model,
    };
    store.addMessage(this.#thread.id, message);
    this.#messageId = message.id;
    return message.id;
  }

  #add(part: Part): PartRef {
    const messageId = this.#message();
    store.addPart(this.#thread.id, messageId, part);
    return { messageId, partId: part.id };
  }

  #finishParts(): void {
    for (const ref of this.#blocks.values())
      store.patchPart(this.#thread.id, ref.messageId, ref.partId, { complete: true });
    for (const ref of this.#tools.values())
      store.patchPart(this.#thread.id, ref.messageId, ref.partId, {
        status: "error",
        output: "The provider stopped before returning a tool result.",
        endedAt: Date.now(),
      });
    this.#tools.clear();
    this.#running.clear();
    endThreadShells(this.id, "failed", true);
    this.#blocks.clear();
    this.#todo = null;
  }

  #trackShell(callId: string, raw: unknown, taskId?: string): void {
    const input = (raw ?? {}) as Record<string, unknown>;
    const command = typeof input.command === "string" ? input.command : typeof input.script === "string" ? input.script : "";
    const native = taskId && this.#session?.stopShell;
    startShell({
      id: `${this.id}:${callId}`, projectId: this.#thread.projectId, threadId: this.id,
      command, cwd: typeof input.cwd === "string" ? input.cwd : this.#cwd,
      background: Boolean(taskId), stopMode: native ? "shell" : "task",
    }, native ? () => native.call(this.#session, taskId) : async () => {
      disposeRuntime(this.id);
      await waitForStoppedProcesses();
    });
  }

  #consume(event: AgentEvent): void {
    if (this.#disposed) return;
    if (this.#thread.transferContext && this.#thread.externalId && (event.type === "block.start" || event.type === "tool.start" || (event.type === "turn.end" && !event.error)))
      store.patchThread(this.id, { transferContext: undefined });
    if (this.#thread.status === "queued" && (event.type === "block.start" || event.type === "tool.start")) store.patchThread(this.id, { status: "thinking" });
    switch (event.type) {
      case "shell.background":
        this.#trackShell(event.callId, { command: event.command, cwd: event.cwd }, event.taskId);
        return;
      case "shell.end":
        if (event.output !== undefined) shellOutput(`${this.id}:${event.callId}`, event.output);
        endShell(`${this.id}:${event.callId}`, event.stopped ? "stopped" : event.ok ? "finished" : "failed");
        return;
      case "tool.output":
        shellOutput(`${this.id}:${event.callId}`, event.output, event.append);
        return;
      case "compacted": {
        const manual = this.#thread.compacting;
        clearTimeout(this.#compactionTimer);
        if (event.contextTokens !== undefined) store.setUsage(this.id, { ...this.#thread.usage, contextTokens: event.contextTokens });
        store.patchThread(this.id, { compacting: false, compactedAt: Date.now(), ...(manual ? { running: false, status: "idle", activeTool: undefined } : {}) });
        this.#add({ id: uid("prt"), kind: "notice", level: "info", text: "Context compacted. Your conversation history is still available here." });
        if (manual) this.#messageId = null;
        return;
      }
      case "subagent":
        store.updateSubagent(this.#thread.id, event);
        return;
      case "session": {
        this.#pendingModel = event.model ?? this.#thread.model;
        store.patchThread(this.#thread.id, {
          externalId: event.externalId || this.#thread.externalId,
          model: this.#thread.model ?? event.model,
        });
        return;
      }
      case "status": {
        if (this.#thread.status === "stopped") return;
        store.patchThread(this.#thread.id, {
          status: hasPendingQuestion(this.#thread.id) ? "awaiting" : event.status,
          activeTool: hasPendingQuestion(this.#thread.id) ? undefined : event.tool,
          ...(event.status === "thinking" ||
          event.status === "working" ||
          event.status === "awaiting"
            ? { running: true }
            : {}),
        });
        return;
      }
      case "block.start": {
        const part: Part =
          event.block === "reasoning"
            ? { id: uid("prt"), kind: "reasoning", text: "", complete: false }
            : { id: uid("prt"), kind: "text", text: "", complete: false };
        this.#blocks.set(event.blockId, this.#add(part));
        return;
      }
      case "block.delta": {
        const ref = this.#blocks.get(event.blockId);
        if (!ref) return;
        store.appendText(this.#thread.id, ref.messageId, ref.partId, event.text);
        return;
      }
      case "block.end": {
        const ref = this.#blocks.get(event.blockId);
        if (ref) store.patchPart(this.#thread.id, ref.messageId, ref.partId, { complete: true });
        this.#blocks.delete(event.blockId);
        return;
      }
      case "tool.start": {
        if (PLAN_TOOLS.has(event.name)) return;
        if (event.name === "Bash" || event.name === "Shell" || event.name === "Monitor") this.#trackShell(event.callId, event.input);
        const described = describeTool(event.name, event.input, this.#cwd);
        const part: ToolPart = {
          id: uid("prt"),
          kind: "tool",
          callId: event.callId,
          name: event.name,
          shape: described.shape,
          headline: described.headline,
          detail: described.detail,
          input: event.input,
          status: "running",
          startedAt: Date.now(),
        };
        this.#tools.set(event.callId, this.#add(part));
        this.#running.add(event.callId);
        return;
      }
      case "tool.input": {
        const ref = this.#tools.get(event.callId);
        if (!ref) return;
        const thread = store.threads.get(this.#thread.id);
        const message = thread?.messages.find((m) => m.id === ref.messageId);
        const part = message?.parts.find((p) => p.id === ref.partId) as ToolPart | undefined;
        if (part && ["Bash", "Shell", "Monitor"].includes(part.name)) this.#trackShell(event.callId, event.input);
        const described = describeTool(part?.name ?? "tool", event.input, this.#cwd);
        store.patchPart(this.#thread.id, ref.messageId, ref.partId, {
          input: event.input,
          shape: described.shape,
          headline: described.headline,
          detail: described.detail,
          patch: previewPatch(part?.name ?? "", event.input),
        });
        return;
      }
      case "tool.end": {
        if (event.output) shellOutput(`${this.id}:${event.callId}`, event.output);
        endShell(`${this.id}:${event.callId}`, event.ok ? "finished" : "failed", true);
        const ref = this.#tools.get(event.callId);
        this.#running.delete(event.callId);
        if (ref) {
          store.patchPart(this.#thread.id, ref.messageId, ref.partId, {
            status: event.ok ? "ok" : "error",
            output: clip(event.output),
            endedAt: Date.now(),
          });
          this.#tools.delete(event.callId);
        }
        if (this.#running.size === 0 && this.#thread.status === "working") {
          store.patchThread(this.#thread.id, { status: "thinking", activeTool: undefined });
        }
        return;
      }
      case "todos": {
        if (this.#todo) {
          store.patchPart(this.#thread.id, this.#todo.messageId, this.#todo.partId, {
            items: event.items,
          });
          return;
        }
        const part: TodoPart = { id: uid("prt"), kind: "todo", items: event.items };
        this.#todo = this.#add(part);
        return;
      }
      case "usage": {
        store.setUsage(this.#thread.id, { ...this.#thread.usage, ...event.usage });
        return;
      }
      case "turn.end": {
        if (!this.#thread.running && !this.#stopping) return;
        cancelQuestions(this.#thread.id);
        this.#stopping?.ended();
        clearTimeout(this.#compactionTimer);
        const stopped = this.#thread.status === "stopped";
        const completed =
          this.#thread.running && this.#thread.status !== "stopped";
        store.setUsage(this.#thread.id, {
          ...this.#thread.usage,
          turns: this.#thread.usage.turns + 1,
        });
        this.#messageId = null;
        this.#finishParts();
        store.patchThread(this.#thread.id, {
          status: stopped ? "stopped" : event.error ? "error" : "idle",
          running: false,
          compacting: false,
          activeTool: undefined,
          error: stopped ? undefined : event.error,
        });
        if (completed)
          store.notify({
            kind: "chat",
            level: event.error ? "error" : "success",
            title: event.error
              ? "Chat needs attention"
              : this.#thread.parentThreadId
                ? "Subagent finished"
                : "Response finished",
            text: event.error ?? this.#thread.title,
            target: {
              view: "chat",
              projectId: this.#thread.projectId,
              threadId: this.#thread.id,
            },
          });
        this.#resume = completed && !event.error;
        this.#checkpointCompletion = finishCheckpoint(this.#thread).catch(() => {}).finally(() => {
          this.#checkpointCompletion = null;
          this.#pump();
        });
        this.#pump();
        return;
      }
      case "notice": {
        if (event.level === "info") return;
        this.#add({ id: uid("prt"), kind: "notice", level: event.level, text: event.text });
        return;
      }
      case "exit": {
        this.#stopping?.release();
        clearTimeout(this.#compactionTimer);
        this.#resume = false;
        if (this.#thread.running && this.#thread.status !== "stopped")
          store.notify({
            kind: "chat",
            level: event.code ? "error" : "success",
            title: event.code
              ? "Provider stopped unexpectedly"
              : "Response finished",
            text: this.#thread.title,
            target: {
              view: "chat",
              projectId: this.#thread.projectId,
              threadId: this.#thread.id,
            },
          });
        disconnectTools(this.#thread.id);
        stopChildren(this.#thread.id);
        cancelThread(this.#thread.id);
        cancelQuestions(this.#thread.id);
        const session = this.#session;
        this.#session = null;
        this.#sessionGeneration += 1;
        session?.dispose();
        endThreadShells(this.id, event.code ? "failed" : "stopped");
        this.#finishParts();
        this.#messageId = null;
        const status = event.code === 0 ? "idle" : "error";
        store.patchThread(this.#thread.id, {
          status: this.#thread.status === "stopped" ? "stopped" : status,
          running: false,
          compacting: false,
          activeTool: undefined,
        });
        return;
      }
    }
  }
}

function previewPatch(name: string, rawInput: unknown): unknown {
  const input = (rawInput ?? {}) as Record<string, unknown>;
  const path = typeof input.file_path === "string" ? input.file_path : "";
  if (!path) return undefined;
  if (name === "Edit" && typeof input.old_string === "string" && typeof input.new_string === "string") {
    return diffLines(input.old_string, input.new_string, basename(path));
  }
  if (name === "Write" && typeof input.content === "string") {
    return diffLines("", input.content, basename(path));
  }
  return undefined;
}

const runtimes = new Map<string, ThreadRuntime>();

export function runtimeFor(threadId: string): ThreadRuntime {
  const existing = runtimes.get(threadId);
  if (existing) return existing;
  const thread = store.threads.get(threadId);
  if (!thread) throw new Error(`unknown thread ${threadId}`);
  const runtime = new ThreadRuntime(thread);
  runtimes.set(threadId, runtime);
  return runtime;
}

export function disposeRuntime(threadId: string, preserveStatus = false): void {
  for (const child of store.threads.values()) {
    if (child.parentThreadId === threadId) disposeRuntime(child.id);
  }
  disconnectTools(threadId);
  cancelThread(threadId);
  if (store.threads.get(threadId)?.running) store.patchThread(threadId, { running: false, status: "stopped", activeTool: undefined });
  runtimes.get(threadId)?.dispose(preserveStatus);
  runtimes.delete(threadId);
}

function stopChildren(threadId: string): void {
  for (const child of store.threads.values()) {
    if (child.parentThreadId !== threadId) continue;
    if (runtimes.has(child.id)) runtimes.get(child.id)!.stop();
    else {
      stopChildren(child.id);
      cancelThread(child.id);
      if (child.running) store.patchThread(child.id, { running: false, status: "stopped", activeTool: undefined });
    }
  }
}

export function disposeAll(): void {
  stopTextGeneration();
  for (const runtime of runtimes.values()) runtime.dispose();
  runtimes.clear();
}

export function providerBusy(providerId: string): boolean {
  return textGenerationBusy(providerId) || [...store.threads.values()].some((thread) => thread.provider === providerId && (thread.running || thread.status === "awaiting" || runtimes.get(thread.id)?.busy));
}

export function reloadProviderSessions(providerIds: Set<string>): void {
  for (const [id, runtime] of runtimes) {
    const thread = store.threads.get(id);
    if (!thread || runtime.busy || !providerIds.has(thread.provider)) continue;
    runtime.dispose(true);
    runtimes.delete(id);
  }
}
