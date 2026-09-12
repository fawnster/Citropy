import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

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
    const instructions = await computerInstructions();
    const version = createHash("sha256").update(instructions).digest("hex");
    const installed = await readFile(marker, "utf8").catch(() => "");
    let target = join(folder, "SKILL.md");
    if (!restore && installed) {
      let current = await readFile(target, "utf8").catch(() => undefined);
      if (current === undefined) {
        target = join(folder, "SKILL.md.citropy-disabled");
        current = await readFile(target, "utf8").catch(() => undefined);
      }
      if (current === undefined) return;
      const fingerprint = createHash("sha256").update(current).digest("hex");
      const previous = installed === "1" ? "212aef00b883de380fc3faea0415a3c18a43efaeb5b6daf39bf66614265eb6b6" : installed;
      if (fingerprint !== previous || fingerprint === version) return;
    }
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if (restore) await rm(join(folder, "SKILL.md.citropy-disabled"), { force: true });
    await writeFile(target, instructions, { mode: 0o600 });
    await writeFile(marker, version, { mode: 0o600 });
  })().finally(() => { installing = undefined; });
  return installing;
}
