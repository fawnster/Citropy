import { createServer } from "node:net";
import { chmod, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { TerminalHost } from "./terminal-host.ts";

const [address, directory] = process.argv.slice(2);
if (!address || !directory) throw new Error("A terminal service address is required.");
const token = await readFile(join(directory, "key"), "utf8");
await writeFile(join(directory, "lock", "pid"), String(process.pid), { mode: 0o600 });
const clients = new Map<import("node:net").Socket, string>();
const host = new TerminalHost(event => {
  const data = JSON.stringify({ event }) + "\n";
  for (const [socket, id] of clients) {
    if (!socket.write(data)) host.flow(event.id, id, true);
    if (socket.writableLength > 512 * 1024) socket.destroy();
  }
});
const server = createServer(socket => {
  const id = randomUUID();
  let authenticated = false;
  let input = "";
  const timer = setTimeout(() => socket.destroy(), 5000);
  socket.setEncoding("utf8");
  socket.on("error", () => {});
  socket.on("drain", () => host.release(id));
  socket.on("close", () => { clearTimeout(timer); clients.delete(socket); host.release(id); host.release(`${id}:render`); });
  socket.on("data", chunk => {
    input += chunk;
    if (input.length > 1024 * 1024) { socket.destroy(); return; }
    let end: number;
    while ((end = input.indexOf("\n")) >= 0) {
      const line = input.slice(0, end); input = input.slice(end + 1);
      void (async () => {
        let request: Record<string, any>;
        try { request = JSON.parse(line); } catch { socket.destroy(); return; }
        // JSON primitives (especially null) cannot be read as protocol envelopes.
        // Reject before the error handler, which also needs a valid request object.
        if (!request || typeof request !== "object" || Array.isArray(request)) { socket.destroy(); return; }
        try {
          if (!authenticated) {
            if (request.op !== "hello" || request.token !== token || request.version !== 1) { socket.destroy(); return; }
            authenticated = true;
            clearTimeout(timer);
            clients.set(socket, id);
          }
          let result: unknown;
          switch (request.op) {
            case "hello": case "list": result = host.list(); break;
            case "open": result = host.open(request.input); break;
            case "write": host.write(request.termId, request.data); break;
            case "resize": host.resize(request.termId, request.cols, request.rows); break;
            case "flow": host.flow(request.termId, `${id}:render`, request.paused === true); break;
            case "close": await host.close(request.termId); break;
            case "closeAll": await host.closeAll(); break;
            default: throw new Error("Unsupported terminal service operation.");
          }
          socket.write(JSON.stringify({ id: request.id, result: result ?? null }) + "\n");
        } catch (error) { socket.write(JSON.stringify({ id: request.id, error: (error as Error).message }) + "\n"); }
      })();
    }
  });
});
server.on("error", () => process.exit(1));
server.listen(address, async () => { if (process.platform !== "win32") await chmod(address, 0o600); });
const idle = setInterval(() => { if (!clients.size && !host.list().some(session => session.running)) void shutdown(); }, 30_000);
async function shutdown() {
  clearInterval(idle);
  server.close();
  await host.closeAll();
  await rm(join(directory!, "lock"), { recursive: true, force: true });
  if (process.platform !== "win32") await rm(address!, { force: true });
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
