import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/** Accept origin-form targets without changing the URL used by individual routes. */
function validTarget(target: string): boolean {
  if (!target.startsWith("/") || target.startsWith("//") || target.includes("#")) return false;
  try {
    const path = decodeURIComponent(target.split("?")[0] ?? "/");
    return !path.startsWith("//") && !/[\\\0]/.test(path);
  } catch {
    return false;
  }
}

/** Finish an unstarted error response or terminate an already-started stream. */
function respondError(res: ServerResponse, status: number, message: string): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  // A route may have prepared length/encoding/cache headers before failing.
  for (const name of res.getHeaderNames()) res.removeHeader(name);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    // Do not leave an unread upload attached to a reusable connection.
    connection: "close",
  }).end(JSON.stringify({ error: message }));
}

/**
 * Protect the HTTP server from synchronous throws and rejected route promises.
 * Malformed targets receive 400 before routing. Unexpected failures are logged
 * locally and receive a generic 500, or close an already-started response.
 */
export function requestHandler(handler: Handler): RequestListener {
  return (req, res) => {
    const run = async () => {
      if (!validTarget(req.url ?? "/")) {
        respondError(res, 400, "Invalid request target.");
        return;
      }
      await handler(req, res);
    };
    // EventEmitter does not await async request listeners. Always consume rejection.
    void run().catch(error => {
      try {
        console.error("HTTP request failed:", error);
        respondError(res, 500, "Internal server error.");
      } catch {
        // Error reporting must not itself create an unhandled rejection.
        res.destroy();
      }
    });
  };
}
