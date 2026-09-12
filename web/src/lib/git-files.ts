import type { GitFile } from "../../../shared/protocol.ts";

export function groupGitFiles(files: GitFile[], staged?: boolean) {
  const groups = [
    { kind: "added", label: "Added", files: [] as GitFile[] },
    { kind: "deleted", label: "Deleted", files: [] as GitFile[] },
    { kind: "changed", label: "Changed", files: [] as GitFile[] },
  ];
  for (const file of files) {
    const code = (staged ?? file.staged) ? file.index : file.work;
    const index = file.untracked || code === "A" || code === "C" ? 0 : code === "D" ? 1 : 2;
    groups[index]!.files.push(file);
  }
  for (const group of groups) group.files.sort((a, b) => a.path.localeCompare(b.path));
  return groups.filter((group) => group.files.length);
}
