import {
  Archive,
  Files,
  GitBranch,
  Globe2,
  History,
  type LucideIcon,
} from "lucide-react";
import type { GitOperation } from "../../../../shared/protocol.ts";

export type Section = "Changes" | "History" | "Branches" | "Stashes" | "Remotes";

export const tabs: Array<{ name: Section; icon: LucideIcon }> = [
  { name: "Changes", icon: Files },
  { name: "History", icon: History },
  { name: "Branches", icon: GitBranch },
  { name: "Stashes", icon: Archive },
  { name: "Remotes", icon: Globe2 },
];

export const workingLabels: Partial<Record<GitOperation, string>> = {
  overview: "Refreshing repository",
  history: "Loading history",
  init: "Initializing repository",
  stage: "Staging file",
  unstage: "Unstaging file",
  stageAll: "Staging changes",
  unstageAll: "Unstaging changes",
  commit: "Creating commit",
  createBranch: "Creating branch",
  switchBranch: "Switching branch",
  deleteBranch: "Deleting branch",
  merge: "Merging branch",
  abortMerge: "Aborting merge",
  fetch: "Fetching remote updates",
  pull: "Pulling changes",
  push: "Pushing commits",
  stash: "Saving changes",
  applyStash: "Applying stash",
  dropStash: "Deleting stash",
  addRemote: "Connecting remote",
  removeRemote: "Removing remote",
  publish: "Publishing branch",
  discardWorktree: "Discarding changes",
};

export const doneLabels: Partial<Record<GitOperation, string>> = {
  init: "Repository initialized. Review your files to make the first commit.",
  stage: "File staged for commit.",
  unstage: "File moved back to unstaged changes.",
  stageAll: "All changes staged.",
  unstageAll: "All changes unstaged.",
  commit: "Commit created.",
  createBranch: "Branch created and checked out.",
  switchBranch: "Branch switched.",
  deleteBranch: "Local branch deleted.",
  merge: "Merge completed.",
  abortMerge: "Merge aborted.",
  fetch: "Remote information updated.",
  pull: "Branch updated from its upstream.",
  push: "Push completed.",
  stash: "Changes saved to a stash.",
  applyStash: "Stash applied. The saved copy is still available.",
  dropStash: "Stash deleted.",
  addRemote: "Remote connected.",
  removeRemote: "Remote configuration removed.",
  publish: "Branch published and upstream configured.",
  discardWorktree: "Unstaged changes discarded.",
};
