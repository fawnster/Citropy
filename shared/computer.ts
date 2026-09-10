export interface ComputerDisplay {
  id: string;
  name: string;
  width: number;
  height: number;
}

export interface ComputerCapabilities {
  available: boolean;
  platform: string;
  backend: string;
  reason?: string;
}

export interface ComputerActivity {
  id: string;
  action: string;
  actor: "provider" | "user";
  at: number;
  status: "running" | "done" | "error";
  error?: string;
}

export interface ComputerState {
  enabled: boolean;
  status: "idle" | "starting" | "active" | "paused" | "error";
  threadId?: string;
  projectId?: string;
  control: boolean;
  displays: ComputerDisplay[];
  activity: ComputerActivity[];
  startedAt?: number;
  lastActionAt?: number;
  error?: string;
  shortcut?: boolean;
}

export interface ComputerFrame {
  id: string;
  displayId: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  capturedAt: number;
  image: string;
}

export type ComputerAction =
  | { action: "move" | "click"; frameId: string; x: number; y: number; button?: "left" | "middle" | "right"; count?: number }
  | { action: "drag"; frameId: string; x: number; y: number; toX: number; toY: number; durationMs?: number }
  | { action: "scroll"; frameId: string; x: number; y: number; deltaX?: number; deltaY?: number }
  | { action: "press"; key: string }
  | { action: "type"; text: string }
  | { action: "wait"; durationMs?: number };
