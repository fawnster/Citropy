import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const builtinSkillRoot = () => join(homedir(), ".citropy", "skills");
let installing: Promise<void> | undefined;

export function computerInstructions() {
  return readFile(new URL("../skills/computer-use/SKILL.md", import.meta.url), "utf8");
}

export function installComputerSkill(restore = false): Promise<void> {
  if (installing && !restore) return installing;
  installing = (async () => {
    const folder = join(builtinSkillRoot(), "computer-use");
    const marker = join(folder, ".installed");
    if (!restore && await readFile(marker, "utf8").catch(() => "")) return;
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if (restore) await rm(join(folder, "SKILL.md.citropy-disabled"), { force: true });
    await writeFile(join(folder, "SKILL.md"), await computerInstructions(), { mode: 0o600 });
    await writeFile(marker, "1", { mode: 0o600 });
  })().finally(() => { installing = undefined; });
  return installing;
}
