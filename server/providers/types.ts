import type {
  Attachment,
  ModelOption,
  PermissionMode,
  ProviderId,
  ThreadStatus,
  TodoItem,
  Usage,
} from "../../shared/protocol.ts";

export type AgentEvent =
  | { type: "compacted"; contextTokens?: number }
  | { type: "subagent"; id: string; title?: string; prompt?: string; model?: string; status: ThreadStatus; result?: string }
  | { type: "session"; externalId: string; model?: string; contextMax?: number }
  | { type: "status"; status: ThreadStatus; tool?: string }
  | { type: "block.start"; blockId: string; block: "text" | "reasoning" }
  | { type: "block.delta"; blockId: string; text: string }
  | { type: "block.end"; blockId: string }
  | { type: "tool.start"; callId: string; name: string; input: unknown }
  | { type: "tool.input"; callId: string; input: unknown }
  | { type: "tool.end"; callId: string; ok: boolean; output: string }
  | { type: "todos"; items: TodoItem[] }
  | { type: "usage"; usage: Partial<Usage> }
  | { type: "turn.end"; error?: string }
  | { type: "notice"; level: "info" | "warn" | "error"; text: string }
  | { type: "exit"; code: number };

export type Emit = (event: AgentEvent) => void;

export interface StartOptions {
  mcp?: { url: string; headers: Record<string, string> };
  threadId: string;
  cwd: string;
  model?: string;
  effort?: string;
  contextMax?: number;
  fastMode?: boolean;
  fastModeTier?: "priority" | "fast";
  permissionMode: PermissionMode;
  externalId?: string;
  usage?: Partial<Usage>;
  emit: Emit;
}

export interface AgentSession {
  send(text: string, attachments?: Attachment[], skills?: Array<{ name: string; path: string }>): void | Promise<void>;
  steer?(text: string, attachments?: Attachment[], skills?: Array<{ name: string; path: string }>): Promise<void>;
  compact?(): Promise<void>;
  interrupt(): void;
  dispose(): void;
}

export interface Provider {
  id: ProviderId;
  label: string;
  binary: string;
  models: ModelOption[];
  listModels(): Promise<ModelOption[]>;
  supportsPermissionPrompt: boolean;
  steerHint?: string;
  detect(): Promise<{ available: boolean; version?: string }>;
  start(options: StartOptions): AgentSession;
}
