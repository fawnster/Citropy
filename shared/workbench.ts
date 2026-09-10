export type PanelKind =
  "browser" | "terminal" | "files" | "changes" | "subagents" | "tools" | "computer";

export interface PanelTab {
  id: string;
  projectId: string;
  kind: PanelKind;
  title: string;
  threadId?: string;
}

export interface BrowserState {
  profileId?: string;
  profileName?: string;
  id: string;
  projectId: string;
  threadId?: string;
  title: string;
  url: string;
  loading: boolean;
  width: number;
  height: number;
  mobile?: boolean;
  scale?: number;
  canGoBack?: boolean;
  canGoForward?: boolean;
  error?: string;
  dialog?: { type: string; message: string };
}

export type BrowserAction =
  | { action: "navigate"; url: string }
  | { action: "back" | "forward" | "reload" | "snapshot" }
  | {
      action: "click";
      x?: number;
      y?: number;
      selector?: string;
      role?: string;
      name?: string;
    }
  | {
      action: "type";
      text: string;
      selector?: string;
      role?: string;
      name?: string;
    }
  | { action: "press"; key: string }
  | { action: "scroll"; x: number; y: number }
  | { action: "resize"; width: number; height: number; mobile?: boolean }
  | { action: "dialog"; accept: boolean; text?: string };

export interface ToolConnection {
  threadId: string;
  connected: boolean;
  lastUsed?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  };
}
