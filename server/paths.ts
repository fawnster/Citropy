import { homedir } from "node:os";
import { join } from "node:path";
import { dev } from "./config.ts";

export const dataRoot = process.env.CITROPY_DATA_DIR || join(homedir(), dev ? ".citropy-dev" : ".citropy");
