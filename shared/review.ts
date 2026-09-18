import type { FilePatch } from "./protocol.ts";

export interface TurnCheckpoint {
  messageId: string;
  createdAt: number;
  before?: string;
  after?: string;
  error?: string;
  overlapping?: boolean;
}

export function fileRestoreIssue(checkpoints: TurnCheckpoint[] | undefined, messageId: string): "missing" | "incomplete" | "shared" | undefined {
  if (!checkpoints?.find(entry => entry.messageId === messageId)?.before) return "missing";
  if (!checkpoints.at(-1)?.after) return "incomplete";
  if (checkpoints.some(entry => entry.overlapping)) return "shared";
}

export type ReviewScope = "lastTurn" | "task" | "unstaged" | "staged";

export interface ChangeReview {
  scope: ReviewScope;
  patches: FilePatch[];
  revision: string;
  messageId?: string;
  note?: string;
}
