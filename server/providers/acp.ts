import * as acp from "@agentclientprotocol/sdk";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { onLines } from "../lines.ts";
import { stopProcess } from "./process.ts";
import { ask, cancelThread } from "../permissions.ts";
import { askQuestion, cancelQuestions } from "../questions.ts";
import type { AgentSession, StartOptions } from "./types.ts";
import type { Attachment, ModelOption, PermissionMode, TodoItem } from "../../shared/protocol.ts";
import type { ProviderCommand } from "../../shared/features.ts";
import { normalizeTodos } from "../../shared/todos.ts";
import { parseAcpUsage } from "../../shared/usage-metrics.ts";

const run = promisify(execFile);

export interface AcpConfig {
  label: string;
  binary: string;
  args: string[];
  loginCommand: string;
  modes: Record<PermissionMode, string>;
  parameterizedModelPicker?: boolean;
  modelListing?: string;
  onCommands?: (cwd: string, commands: ProviderCommand[]) => void;
}

interface CursorAskQuestion {
  id: string;
  prompt: string;
  options: Array<{ id: string; label: string }>;
  allowMultiple?: boolean;
}

interface CursorAskQuestionRequest {
  toolCallId: string;
  title?: string;
  questions: CursorAskQuestion[];
}

interface CursorTodo {
  id?: string;
  content?: string;
  title?: string;
  status?: string;
}

type CursorAskQuestionResponse = {
  outcome:
    | { outcome: "answered"; answers: Array<{ questionId: string; selectedOptionIds: string[] }> }
    | { outcome: "cancelled" };
};

interface CursorCreatePlanRequest {
  toolCallId: string;
  name?: string;
  overview?: string;
  plan: string;
  todos: CursorTodo[];
  isProject?: boolean;
}

type CursorCreatePlanResponse = {
  outcome: { outcome: "accepted" } | { outcome: "rejected"; reason?: string } | { outcome: "cancelled" };
};

interface CursorUpdateTodosRequest {
  toolCallId: string;
  todos: CursorTodo[];
  merge: boolean;
}

const extensionParams = <T>(): { parse(value: unknown): T } => ({ parse: (value) => value as T });

type ToolCallLike = acp.ToolCall | acp.ToolCallUpdate;

interface ToolState {
  name: string;
  raw: unknown;
  input: unknown;
  hidden: boolean;
  started: boolean;
  ended: boolean;
  title: string;
  kind: string;
  content?: Array<acp.ToolCallContent> | null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(errorMessage(error))); },
    );
  });
}

function signedOut(config: AcpConfig, error: unknown): Error {
  if (error instanceof acp.RequestError && error.code === -32000)
    return new Error(`${config.label} is not signed in. Run \`${config.loginCommand}\` in a terminal, then try again.`);
  return error instanceof Error ? error : new Error(errorMessage(error));
}

type SelectOption =Extract<acp.SessionConfigOption, { type: "select" }>;

function contextTokens(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(k|m)?$/i.exec(value.trim());
  if (!match) return undefined;
  const unit = match[2]?.toLowerCase();
  return Number(match[1]) * (unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1);
}

function contextMax(id: string): number | undefined {
  const match = /context=(\d+(?:\.\d+)?[km]?)/i.exec(id);
  return match ? contextTokens(match[1]!) : undefined;
}

function modelHint(id: string): string | undefined {
  const match = /\[([^\]]*)\]/.exec(id);
  if (!match) return undefined;
  const params: Record<string, string> = {};
  for (const part of match[1]!.split(",")) {
    const [key, value] = part.split("=");
    if (key && value) params[key.trim()] = value.trim();
  }
  const parts: string[] = [];
  if (params.context) parts.push(`${params.context} context`);
  const effort = params.effort ?? params.reasoning ?? params.reasoning_effort;
  if (effort) parts.push(`${effort} effort`);
  if (params.fast === "true") parts.push("fast");
  if (params.thinking === "true" && !effort) parts.push("thinking");
  return parts.length ? parts.join(" · ") : undefined;
}

function selectOption(options: acp.SessionConfigOption[] | null | undefined, category: string, predicate?: (option: SelectOption) => boolean): SelectOption | undefined {
  return (options ?? []).find(
    (entry): entry is SelectOption =>
      entry.type === "select" && entry.category === category && (!predicate || predicate(entry)),
  );
}

function optionValues(option: SelectOption): string[] {
  const values: string[] = [];
  for (const entry of option.options ?? []) {
    if ("value" in entry) values.push(entry.value);
    else for (const nested of entry.options) values.push(nested.value);
  }
  return values;
}

const EFFORT_VALUES = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

function effortOption(options: acp.SessionConfigOption[] | null | undefined): SelectOption | undefined {
  return selectOption(options, "thought_level", (option) => optionValues(option).some((value) => EFFORT_VALUES.has(value)));
}

function contextOption(options: acp.SessionConfigOption[] | null | undefined): SelectOption | undefined {
  return selectOption(options, "model_config", (option) => {
    const values = optionValues(option);
    return values.length > 0 && values.every((value) => contextTokens(value) !== undefined);
  });
}

function fastOption(options: acp.SessionConfigOption[] | null | undefined): SelectOption | undefined {
  return selectOption(options, "model_config", (option) =>
    /fast/i.test(`${option.id} ${option.name}`) && optionValues(option).includes("true"),
  );
}

function modelSelect(response: acp.NewSessionResponse): SelectOption | undefined {
  return selectOption(response.configOptions, "model");
}

function legacyModels(response: acp.NewSessionResponse): { currentModelId?: string; availableModels?: Array<{ modelId: string; name: string }> } | undefined {
  return (response as acp.NewSessionResponse & { models?: { currentModelId?: string; availableModels?: Array<{ modelId: string; name: string }> } }).models;
}

export function acpCurrentModel(response: acp.NewSessionResponse): string | undefined {
  return modelSelect(response)?.currentValue ?? legacyModels(response)?.currentModelId;
}

function modelLabels(option: SelectOption | undefined): Map<string, string> {
  const labels = new Map<string, string>();
  for (const entry of option?.options ?? []) {
    if ("value" in entry) labels.set(entry.value, entry.name);
    else for (const nested of entry.options) labels.set(nested.value, nested.name);
  }
  return labels;
}

function describeModel(id: string, label: string | undefined, options: acp.SessionConfigOption[] | null | undefined): ModelOption {
  const effort = effortOption(options);
  const context = contextOption(options);
  const fast = fastOption(options);
  const windows = context ? optionValues(context).map(contextTokens).filter((value): value is number => value !== undefined) : [];
  return {
    id,
    label: label ?? id,
    hint: modelHint(id),
    isDefault: id.startsWith("default"),
    efforts: effort ? optionValues(effort) : [],
    defaultEffort: effort?.currentValue ?? undefined,
    contextWindows: windows.length > 1 ? windows : undefined,
    contextMax: context ? contextTokens(context.currentValue) : contextMax(id),
    fastMode: Boolean(fast),
    fastModeHint: fast ? "Cursor runs this model faster with increased usage" : undefined,
  };
}

export function acpModelOptions(response: acp.NewSessionResponse): ModelOption[] {
  const select = modelSelect(response);
  const values: Array<{ id: string; label: string }> = [];
  if (select) {
    const labels = modelLabels(select);
    for (const value of optionValues(select)) values.push({ id: value, label: labels.get(value) ?? value });
  } else {
    for (const model of legacyModels(response)?.availableModels ?? [])
      values.push({ id: model.modelId, label: model.name });
  }
  return values.map(({ id, label }) => describeModel(id, label, undefined));
}

function toolReading(call: ToolCallLike): { name: string; input: unknown } {
  const raw = (call.rawInput ?? {}) as Record<string, unknown>;
  const path = call.locations?.[0]?.path ?? (typeof raw.path === "string" ? raw.path : "");
  switch (call.kind ?? "other") {
    case "execute":
      return { name: "Bash", input: { command: typeof raw.command === "string" ? raw.command : call.title } };
    case "edit":
    case "delete":
    case "move":
      return { name: "Edit", input: { file_path: path } };
    case "read":
      return { name: "Read", input: { file_path: path } };
    case "search":
      return { name: "Grep", input: { pattern: typeof raw.pattern === "string" ? raw.pattern : call.title } };
    case "fetch":
      return { name: "WebFetch", input: { url: typeof raw.url === "string" ? raw.url : call.title } };
    default:
      if (typeof raw.providerIdentifier === "string" && typeof raw.toolName === "string")
        return { name: `mcp__${raw.providerIdentifier}__${raw.toolName}`, input: raw.args ?? {} };
      return { name: call.name ?? call.title ?? "Tool", input: call.rawInput ?? {} };
  }
}

function contentText(content?: Array<acp.ToolCallContent> | null, rawOutput?: unknown): string {
  const parts: string[] = [];
  for (const block of content ?? []) {
    if (block.type === "content" && block.content.type === "text") parts.push(block.content.text);
    else if (block.type === "diff") parts.push(`${block.path}\n${block.newText}`);
    else if (block.type === "terminal") parts.push(block.terminalId);
  }
  if (rawOutput !== undefined && rawOutput !== null) {
    const text = typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput);
    if (text) parts.push(text);
  }
  return parts.join("\n");
}

function contentImages(content?: Array<acp.ToolCallContent> | null): Array<{ mime: string; data: string }> {
  const images: Array<{ mime: string; data: string }> = [];
  for (const block of content ?? []) {
    if (block.type === "content" && block.content.type === "image" && typeof block.content.data === "string" && typeof block.content.mimeType === "string")
      images.push({ mime: block.content.mimeType, data: block.content.data });
  }
  return images;
}

function pickOption(options: acp.PermissionOption[], decision: "allow" | "allow_always" | "deny"): string | undefined {
  const order = decision === "deny"
    ? ["reject_once", "reject_always"]
    : decision === "allow_always"
      ? ["allow_always", "allow_once"]
      : ["allow_once", "allow_always"];
  for (const kind of order) {
    const option = options.find((entry) => entry.kind === kind);
    if (option) return option.optionId;
  }
  return undefined;
}

export class AcpSession implements AgentSession {
  #config: AcpConfig;
  #options: StartOptions;
  #child: ChildProcessWithoutNullStreams;
  #connection: acp.ClientConnection;
  #ready: Promise<void>;
  #sessionId = "";
  #capabilities: acp.AgentCapabilities = {};
  #busy = false;
  #disposed = false;
  #failed = false;
  #loading = false;
  #cancelled = false;
  #queue: Array<{ text: string; attachments: Attachment[] }> = [];
  #blocks = new Map<string, string>();
  #tools = new Map<string, ToolState>();
  #todos: TodoItem[] = [];
  #segment = 0;
  #stderr = "";

  constructor(config: AcpConfig, options: StartOptions) {
    this.#config = config;
    this.#options = options;
    this.#child = spawn(config.binary, config.args, {
      detached: process.platform !== "win32",
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stream = acp.ndJsonStream(
      Writable.toWeb(this.#child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(this.#child.stdout) as ReadableStream<Uint8Array>,
    );
    const app = acp.client({ name: "citropy" })
      .onRequest(acp.methods.client.session.requestPermission, (context) => this.#permission(context.params))
      .onNotification(acp.methods.client.session.update, (context) => { this.#receive(context.params); })
      .onRequest("cursor/ask_question", extensionParams<CursorAskQuestionRequest>(), (context) => this.#askQuestion(context.params, context.signal))
      .onRequest("cursor/create_plan", extensionParams<CursorCreatePlanRequest>(), (context) => this.#createPlan(context.params, context.signal))
      .onNotification("cursor/update_todos", extensionParams<CursorUpdateTodosRequest>(), (context) => { this.#updateTodos(context.params); });
    this.#connection = app.connect(stream);
    onLines(this.#child.stderr, (line) => { this.#stderr = `${this.#stderr}${line}\n`.slice(-4000); });
    this.#child.stdin.on("error", (error) => this.#fail(error.message));
    this.#child.on("error", (error) => this.#fail(error.message));
    this.#child.on("close", (code) => this.#fail(this.#stderr.trim() || `${config.label} exited with code ${code}`));
    void this.#connection.closed.then(
      () => this.#fail(this.#stderr.trim() || `${config.label} closed the ACP connection`),
      (error: unknown) => this.#fail(errorMessage(error)),
    );
    this.#ready = this.#initialize();
    void this.#ready.catch((error: Error) => this.#fail(error.message));
  }

  #agent(): acp.ClientContext {
    return this.#connection.agent;
  }

  async #initialize(): Promise<void> {
    const { label } = this.#config;
    const init = await withTimeout(
      this.#agent().request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          ...(this.#config.parameterizedModelPicker ? { _meta: { parameterizedModelPicker: true } } : {}),
        },
        clientInfo: { name: "citropy", version: "0.1.0" },
      }),
      30_000,
      `${label} did not answer the ACP handshake within 30 seconds`,
    );
    if (init.protocolVersion !== acp.PROTOCOL_VERSION)
      throw new Error(`${label} speaks ACP version ${init.protocolVersion}; this Citropy build supports version ${acp.PROTOCOL_VERSION}.`);
    this.#capabilities = init.agentCapabilities ?? {};
    const mcpServers: Array<acp.McpServer> = [];
    if (this.#options.mcp) {
      if (this.#capabilities.mcpCapabilities?.http) {
        mcpServers.push({
          type: "http",
          name: "citropy",
          url: this.#options.mcp.url,
          headers: Object.entries(this.#options.mcp.headers).map(([name, value]) => ({ name, value })),
        });
      } else {
        this.#options.emit({ type: "notice", level: "warn", text: `${label} does not accept Citropy's MCP connection; workspace and browser tools are unavailable in this conversation.` });
      }
    }
    const resume = Boolean(this.#options.externalId && this.#capabilities.loadSession);
    this.#loading = resume;
    let response: acp.NewSessionResponse | undefined;
    let restored: { configOptions?: acp.SessionConfigOption[] } | undefined;
    if (resume) {
      restored = await withTimeout(
        this.#agent().request(acp.methods.agent.session.load, { sessionId: this.#options.externalId!, cwd: this.#options.cwd, mcpServers }),
        60_000,
        `${label} did not restore the conversation within 60 seconds`,
      ).catch((error: unknown) => { throw signedOut(this.#config, error); }) as { configOptions?: acp.SessionConfigOption[] };
      this.#sessionId = this.#options.externalId!;
    } else {
      response = await withTimeout(
        this.#agent().request(acp.methods.agent.session.new, { cwd: this.#options.cwd, mcpServers }),
        60_000,
        `${label} did not start a session within 60 seconds`,
      ).catch((error: unknown) => { throw signedOut(this.#config, error); });
      this.#sessionId = response.sessionId;
    }
    this.#loading = false;
    const applied = await this.#applyConfig(response?.configOptions ?? restored?.configOptions);
    const currentModel = selectOption(applied, "model")?.currentValue ?? (response ? acpCurrentModel(response) : undefined) ?? this.#options.model;
    const context = contextOption(applied);
    const mode = this.#config.modes[this.#options.permissionMode];
    const currentMode = response?.modes?.currentModeId ?? selectOption(applied, "mode")?.currentValue;
    if (mode && mode !== currentMode)
      await withTimeout(this.#agent().request(acp.methods.agent.session.setMode, { sessionId: this.#sessionId, modeId: mode }), 30_000, `${label} did not switch modes`);
    this.#options.emit({
      type: "session",
      externalId: this.#sessionId,
      model: currentModel,
      contextMax: context ? contextTokens(context.currentValue) : this.#options.contextMax ?? contextMax(currentModel ?? ""),
    });
  }

  async #setConfig(configId: string, value: string): Promise<acp.SessionConfigOption[]> {
    const result = await withTimeout(
      this.#agent().request(acp.methods.agent.session.setConfigOption, { sessionId: this.#sessionId, configId, value }),
      30_000,
      `${this.#config.label} did not apply ${configId} within 30 seconds`,
    );
    return result.configOptions ?? [];
  }

  async #applyConfig(initial: acp.SessionConfigOption[] | null | undefined): Promise<acp.SessionConfigOption[]> {
    const { label } = this.#config;
    let options = initial ?? [];
    const model = selectOption(options, "model");
    if (model && this.#options.model && this.#options.model !== model.currentValue) {
      try { options = await this.#setConfig(model.id, this.#options.model); }
      catch (error) { this.#options.emit({ type: "notice", level: "warn", text: `${label} could not select ${this.#options.model}: ${errorMessage(error)}` }); }
    } else if (!model && this.#options.model) {
      try { options = await this.#setConfig("model", this.#options.model); }
      catch {
        try { await this.#agent().request("session/set_model", { sessionId: this.#sessionId, modelId: this.#options.model }); }
        catch (error) { this.#options.emit({ type: "notice", level: "warn", text: `${label} could not select ${this.#options.model}: ${errorMessage(error)}` }); }
      }
    }
    const effort = effortOption(options);
    if (effort && this.#options.effort && effort.currentValue !== this.#options.effort && optionValues(effort).includes(this.#options.effort)) {
      try { options = await this.#setConfig(effort.id, this.#options.effort); }
      catch (error) { this.#options.emit({ type: "notice", level: "warn", text: `${label} could not set ${this.#options.effort} effort: ${errorMessage(error)}` }); }
    }
    const context = contextOption(options);
    if (context && this.#options.contextMax) {
      const value = optionValues(context).find((entry) => contextTokens(entry) === this.#options.contextMax);
      if (value && context.currentValue !== value) {
        try { options = await this.#setConfig(context.id, value); }
        catch (error) { this.#options.emit({ type: "notice", level: "warn", text: `${label} could not set the context window: ${errorMessage(error)}` }); }
      }
    }
    const fast = fastOption(options);
    if (fast) {
      const value = this.#options.fastMode === true ? "true" : "false";
      if (fast.currentValue !== value && optionValues(fast).includes(value)) {
        try { options = await this.#setConfig(fast.id, value); }
        catch (error) { this.#options.emit({ type: "notice", level: "warn", text: `${label} could not set fast mode: ${errorMessage(error)}` }); }
      }
    }
    return options;
  }

  send(text: string, attachments: Attachment[] = []): void {
    if (this.#disposed || this.#failed) return;
    this.#queue.push({ text, attachments });
    void this.#pump();
  }

  async #content(attachments: Attachment[]): Promise<Array<acp.ContentBlock>> {
    const content: Array<acp.ContentBlock> = [];
    for (const file of attachments) {
      if (file.mime?.startsWith("image/") && this.#capabilities.promptCapabilities?.image) {
        const data = await readFile(file.path);
        content.push({ type: "image", mimeType: file.mime, data: data.toString("base64") });
      } else {
        content.push({ type: "resource_link", uri: pathToFileURL(file.path).href, name: file.label, mimeType: file.mime });
      }
    }
    return content;
  }

  async #pump(): Promise<void> {
    if (this.#busy || this.#disposed || this.#failed || !this.#queue.length) return;
    const next = this.#queue.shift()!;
    this.#busy = true;
    try {
      await this.#ready;
      if (this.#disposed || this.#failed) return;
      const response = await this.#agent().request(acp.methods.agent.session.prompt, {
        sessionId: this.#sessionId,
        prompt: [{ type: "text", text: next.text || "Please inspect the attached files." }, ...(await this.#content(next.attachments))],
      });
      if (this.#disposed) return;
      const usage = parseAcpUsage(response);
      if (Object.keys(usage).length) this.#options.emit({ type: "usage", usage });
      if (response.stopReason === "refusal") this.#finish(`${this.#config.label} refused to continue.`);
      else {
        if (response.stopReason === "max_tokens" || response.stopReason === "max_turn_requests")
          this.#options.emit({ type: "notice", level: "warn", text: `${this.#config.label} stopped early: ${response.stopReason.replaceAll("_", " ")}.` });
        this.#finish();
      }
    } catch (error) {
      if (!this.#disposed && !this.#failed) this.#finish(errorMessage(error));
    }
  }

  interrupt(): void {
    if (this.#queue.length)
      this.#options.emit({ type: "notice", level: "warn", text: this.#queue.length === 1 ? "Stopped before your latest message was sent. Send it again to run it." : `Stopped before your last ${this.#queue.length} messages were sent. Send them again to run them.` });
    this.#queue = [];
    cancelThread(this.#options.threadId);
    cancelQuestions(this.#options.threadId);
    if (!this.#busy || !this.#sessionId) return;
    this.#cancelled = true;
    void this.#agent().notify(acp.methods.agent.session.cancel, { sessionId: this.#sessionId }).catch(() => {});
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#queue = [];
    cancelThread(this.#options.threadId);
    cancelQuestions(this.#options.threadId);
    this.#connection.close();
    this.#child.stdin.end();
    stopProcess(this.#child, true);
  }

  #fail(message: string): void {
    if (this.#disposed || this.#failed) return;
    this.#failed = true;
    if (this.#busy) this.#finish(message);
    else this.#options.emit({ type: "notice", level: "error", text: message });
    this.#options.emit({ type: "exit", code: 1 });
    this.dispose();
  }

  #finish(error?: string): void {
    if (!this.#busy) return;
    this.#busy = false;
    this.#cancelled = false;
    for (const blockId of this.#blocks.keys()) this.#options.emit({ type: "block.end", blockId });
    this.#blocks.clear();
    this.#tools.clear();
    cancelThread(this.#options.threadId, false);
    cancelQuestions(this.#options.threadId);
    this.#options.emit({ type: "turn.end", ...(error ? { error } : {}) });
    void this.#pump();
  }

  #text(id: string, kind: "text" | "reasoning", text: string): void {
    if (!text) return;
    const blockId = `${id}:${kind}:${this.#segment}`;
    if (!this.#blocks.has(blockId)) this.#options.emit({ type: "block.start", blockId, block: kind });
    this.#blocks.set(blockId, `${this.#blocks.get(blockId) ?? ""}${text}`);
    this.#options.emit({ type: "block.delta", blockId, text });
  }

  #breakText(): void {
    for (const blockId of this.#blocks.keys()) this.#options.emit({ type: "block.end", blockId });
    this.#blocks.clear();
    this.#segment += 1;
  }

  #receive(notification: acp.SessionNotification): void {
    if (this.#disposed || this.#failed) return;
    if (notification.sessionId !== this.#sessionId || this.#loading) return;
    const update = notification.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") this.#text(update.messageId ?? "message", "text", update.content.text);
        return;
      case "agent_thought_chunk":
        if (update.content.type === "text") this.#text(update.messageId ?? "thought", "reasoning", update.content.text);
        return;
      case "tool_call":
        this.#toolCall(update, true);
        return;
      case "tool_call_update":
        this.#toolCall(update, false);
        return;
      case "plan":
        this.#plan(update.entries);
        return;
      case "usage_update": {
        const usage = parseAcpUsage(update);
        if (Object.keys(usage).length) this.#options.emit({ type: "usage", usage });
        return;
      }
      case "available_commands_update":
        this.#config.onCommands?.(this.#options.cwd, update.availableCommands.flatMap((command) => {
          const name = command.name.trim();
          if (!name) return [];
          const description = command.description.trim();
          const hint = command.input?.hint.trim();
          return [{ name, description: description || "Cursor command", ...(hint ? { argumentHint: hint } : {}) }];
        }));
        return;
      default:
        return;
    }
  }

  #plan(entries: acp.PlanEntry[]): void {
    const items: TodoItem[] = normalizeTodos(entries);
    if (items.length) {
      this.#todos = items;
      this.#options.emit({ type: "todos", items });
    }
  }

  async #askQuestion(params: CursorAskQuestionRequest, signal: AbortSignal): Promise<CursorAskQuestionResponse> {
    const asked = params.questions.slice(0, 4);
    const questions = asked.map((question) => ({
      id: question.id,
      question: question.prompt,
      options: question.options.length
        ? question.options.slice(0, 12).map((option) => ({ label: option.label }))
        : [{ label: "OK" }],
      multiple: question.allowMultiple === true,
    }));
    if (!questions.length) return { outcome: { outcome: "answered", answers: [] } };
    const result = await askQuestion(this.#options.threadId, questions, { signal });
    if (result.cancelled) return { outcome: { outcome: "cancelled" } };
    return {
      outcome: {
        outcome: "answered",
        answers: asked.map((question) => ({
          questionId: question.id,
          selectedOptionIds: (result.answers[question.id] ?? []).flatMap((label) =>
            question.options.filter((option) => option.label.trim() === label).map((option) => option.id)),
        })),
      },
    };
  }

  async #createPlan(params: CursorCreatePlanRequest, signal: AbortSignal): Promise<CursorCreatePlanResponse> {
    if (!this.#todos.length) this.#updateTodos({ toolCallId: params.toolCallId, todos: params.todos, merge: false });
    if (this.#options.permissionMode === "bypass") return { outcome: { outcome: "accepted" } };
    this.#breakText();
    this.#text(`plan:${params.toolCallId}`, "text", params.plan);
    this.#breakText();
    const accept = "Accept the plan";
    const reject = "Keep planning";
    const result = await askQuestion(this.#options.threadId, [{
      id: "plan",
      header: params.name?.trim() || "Plan",
      question: `${this.#config.label} wrote the plan above. Accept it?`,
      options: [{ label: accept }, { label: reject }],
    }], { signal });
    if (result.cancelled) return { outcome: { outcome: "cancelled" } };
    const answer = result.answers.plan?.[0];
    if (answer === accept) {
      if (this.#options.permissionMode === "plan") this.#options.emit({ type: "plan.accepted" });
      return { outcome: { outcome: "accepted" } };
    }
    return { outcome: { outcome: "rejected", ...(answer && answer !== reject ? { reason: answer } : {}) } };
  }

  #updateTodos(params: CursorUpdateTodosRequest): void {
    if (params.merge) {
      const merged = [...this.#todos];
      for (const entry of normalizeTodos(params.todos)) {
        const index = merged.findIndex((todo) => todo.text === entry.text);
        if (index === -1) merged.push(entry);
        else merged[index] = { ...merged[index]!, status: entry.status };
      }
      this.#todos = merged;
    } else {
      this.#todos = normalizeTodos(params.todos);
    }
    if (this.#todos.length) this.#options.emit({ type: "todos", items: this.#todos });
  }

  #toolCall(update: ToolCallLike, initial: boolean): void {
    const state = this.#tools.get(update.toolCallId) ?? {
      name: "", raw: undefined, input: undefined, hidden: false, started: false, ended: false, title: "", kind: "other",
    };
    if (update.kind) state.kind = update.kind;
    if (update.title) state.title = update.title;
    if (update.rawInput !== undefined && update.rawInput !== null) state.raw = update.rawInput;
    if (update.content !== undefined && update.content !== null) state.content = update.content;
    if ((state.raw as { _toolName?: unknown } | undefined)?._toolName === "createPlan") state.hidden = true;
    const reading = toolReading({ ...update, kind: state.kind as acp.ToolKind, title: state.title, rawInput: state.raw });
    const renamed = state.started && reading.name !== state.name;
    state.name = reading.name;
    state.input = reading.input;
    this.#tools.set(update.toolCallId, state);
    if (state.hidden) {
      if (state.started && !state.ended) {
        state.ended = true;
        this.#options.emit({ type: "tool.end", callId: update.toolCallId, ok: true, output: "" });
      }
      return;
    }
    if (!state.started) {
      state.started = true;
      this.#breakText();
      this.#options.emit({ type: "tool.start", callId: update.toolCallId, name: state.name, input: state.input });
    } else if (renamed || update.rawInput !== undefined || update.locations !== undefined) {
      this.#options.emit({ type: "tool.input", callId: update.toolCallId, input: state.input, ...(renamed ? { name: state.name } : {}) });
    }
    const status = update.status ?? (initial ? "pending" : undefined);
    if (status === "in_progress" || status === "pending")
      this.#options.emit({ type: "status", status: "working", tool: state.name });
    if ((status === "completed" || status === "failed") && !state.ended) {
      state.ended = true;
      const images = contentImages(state.content);
      this.#options.emit({ type: "tool.end", callId: update.toolCallId, ok: status === "completed", output: contentText(state.content, "rawOutput" in update ? update.rawOutput : undefined), ...(images.length ? { images } : {}) });
    }
  }

  async #permission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const cancelled: acp.RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
    if (this.#disposed || this.#failed || this.#cancelled) return cancelled;
    const kind = params.toolCall.kind ?? this.#tools.get(params.toolCall.toolCallId)?.kind ?? "other";
    const stored = this.#tools.get(params.toolCall.toolCallId);
    const reading = toolReading({ ...params.toolCall, kind: kind as acp.ToolKind, rawInput: params.toolCall.rawInput ?? stored?.raw, title: params.toolCall.title ?? stored?.title });
    const selected = (decision: "allow" | "allow_always" | "deny") => {
      const optionId = pickOption(params.options, decision);
      return optionId ? { outcome: { outcome: "selected" as const, optionId } } : cancelled;
    };
    if (this.#options.permissionMode === "bypass" || reading.name.startsWith("mcp__citropy__")) return selected("allow");
    if (this.#options.permissionMode === "plan") return selected("deny");
    if (this.#options.permissionMode === "acceptEdits" && ["edit", "delete", "move"].includes(kind)) return selected("allow");
    this.#options.emit({ type: "status", status: "awaiting" });
    const decision = await ask(this.#options.threadId, reading.name, reading.input);
    if (!this.#disposed) this.#options.emit({ type: "status", status: "working" });
    return selected(decision);
  }
}

export async function acpModels(config: AcpConfig): Promise<ModelOption[]> {
  const child = spawn(config.binary, config.args, {
    detached: process.platform !== "win32",
    cwd: tmpdir(),
    env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const connection = acp.client({ name: "citropy" }).connect(stream);
  try {
    const init = await withTimeout(
      connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          ...(config.parameterizedModelPicker ? { _meta: { parameterizedModelPicker: true } } : {}),
        },
        clientInfo: { name: "citropy", version: "0.1.0" },
      }),
      30_000,
      `${config.label} did not answer the ACP handshake within 30 seconds`,
    );
    if (init.protocolVersion !== acp.PROTOCOL_VERSION)
      throw new Error(`${config.label} speaks ACP version ${init.protocolVersion}; this Citropy build supports version ${acp.PROTOCOL_VERSION}.`);
    if (config.modelListing) {
      const listing = await withTimeout(
        connection.agent.request(config.modelListing, {}) as Promise<{ models?: Array<{ value?: unknown; name?: unknown; configOptions?: acp.SessionConfigOption[] | null }> }>,
        20_000,
        `${config.label} did not list models within 20 seconds`,
      ).catch((error: unknown) => { throw signedOut(config, error); });
      return (listing.models ?? []).flatMap((entry) =>
        typeof entry.value === "string" && typeof entry.name === "string"
          ? [describeModel(entry.value, entry.name, entry.configOptions)]
          : []);
    }
    const response = await withTimeout(
      connection.agent.request(acp.methods.agent.session.new, { cwd: tmpdir(), mcpServers: [] }),
      60_000,
      `${config.label} did not return models within 60 seconds`,
    ).catch((error: unknown) => { throw signedOut(config, error); });
    const select = modelSelect(response);
    if (!select) return acpModelOptions(response);
    const labels = modelLabels(select);
    const initial = select.currentValue;
    const models: ModelOption[] = [];
    for (const value of optionValues(select)) {
      if (!value.startsWith("default") && value !== initial) {
        try {
          const result = await withTimeout(
            connection.agent.request(acp.methods.agent.session.setConfigOption, { sessionId: response.sessionId, configId: select.id, value }),
            10_000,
            `${config.label} did not describe ${value} within 10 seconds`,
          );
          models.push(describeModel(value, labels.get(value), result.configOptions));
          continue;
        } catch {
          // Fall through to the undiscovered description.
        }
      }
      models.push(describeModel(value, labels.get(value), value === initial ? response.configOptions : undefined));
    }
    if (initial) {
      await withTimeout(
        connection.agent.request(acp.methods.agent.session.setConfigOption, { sessionId: response.sessionId, configId: select.id, value: initial }),
        10_000,
        `${config.label} did not restore ${initial} within 10 seconds`,
      ).catch(() => undefined);
    }
    return models;
  } finally {
    connection.close();
    child.stdin.end();
    stopProcess(child, true);
  }
}

export async function acpDetect(config: AcpConfig): Promise<{ available: boolean; version?: string }> {  try {
    const { stdout, stderr } = await run(config.binary, ["--version"], { timeout: 8000 });
    return { available: true, version: (stdout || stderr).trim().split("\n")[0] };
  } catch {
    return { available: false };
  }
}
