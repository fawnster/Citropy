import { homedir } from "node:os";
import { join } from "node:path";

export const dataRoot = process.env.CITROPY_DATA_DIR || join(homedir(), ".citropy");
