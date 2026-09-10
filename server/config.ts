import { env, argv } from "node:process";

export const port = Number(env.CITROPY_PORT ?? 4177);
export const host = env.CITROPY_HOST ?? "127.0.0.1";
export let dev = argv.includes("--dev");
export function setDevelopment(enabled: boolean): void {
  dev = enabled;
}
export const origin = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
