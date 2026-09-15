import { createServer, request } from "node:http";

export async function remoteProxy(allowedOrigin) {
  let target;
  const sockets = new Set();
  const streams = new Set();
  const requests = new Set();
  const origin = () => typeof allowedOrigin === "function" ? allowedOrigin() : allowedOrigin;
  const trusted = req => {
    const host = `127.0.0.1:${server.address().port}`;
    if (req.headers.host !== host) return false;
    if (req.headers.origin) return req.headers.origin === origin();
    if (req.headers["sec-fetch-site"] !== "cross-site") return true;
    try { return new URL(req.headers.referer || "").origin === origin(); } catch { return false; }
  };
  const headersFor = req => ({ ...req.headers, host: `127.0.0.1:${target.remotePort}`, origin: `http://127.0.0.1:${target.remotePort}`, "x-citropy-remote-token": target.token });
  const server = createServer((req, res) => {
    if (!trusted(req)) { res.writeHead(403).end(); return; }
    const cors = { "access-control-allow-origin": origin(), vary: "Origin" };
    if (!req.url?.startsWith("/api/") || req.url.startsWith("/api/remote/shutdown") || req.url.startsWith("/api/desktop") || req.url.startsWith("/api/updates/")) { res.writeHead(404, cors).end(); return; }
    if (req.method === "OPTIONS") { res.writeHead(204, { ...cors, "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE", "access-control-allow-headers": "Content-Type" }).end(); return; }
    if (!target) { res.writeHead(503, { ...cors, "content-type": "application/json" }).end(JSON.stringify({ error: "The SSH connection is disconnected. Reconnect or switch to Local." })); return; }
    const headers = headersFor(req);
    delete headers.cookie;
    const upstream = request({ hostname: "127.0.0.1", port: target.port, method: req.method, path: req.url, headers }, response => {
      if (res.writableEnded || res.destroyed) { response.destroy(); return; }
      const responseHeaders = { ...response.headers, ...cors };
      delete responseHeaders["set-cookie"];
      res.writeHead(response.statusCode || 502, responseHeaders);
      response.pipe(res);
    });
    const active = { upstream, res, req, cors };
    requests.add(active);
    upstream.on("error", () => {
      if (res.writableEnded) return;
      if (!res.headersSent) res.writeHead(502, { ...cors, "content-type": "application/json" }).end(JSON.stringify({ error: "The SSH backend could not be reached. Reconnect and try again." }));
      else res.destroy();
    });
    upstream.setTimeout(300000, () => upstream.destroy());
    res.on("close", () => { requests.delete(active); upstream.destroy(); });
    req.pipe(upstream);
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("upgrade", (req, client, head) => {
    if (!trusted(req) || req.url !== "/socket" || !target) { client.destroy(); return; }
    streams.add(client);
    client.on("close", () => streams.delete(client));
    const headers = headersFor(req);
    delete headers.cookie;
    const upstream = request({ hostname: "127.0.0.1", port: target.port, path: "/socket", headers });
    upstream.on("upgrade", (response, socket, buffered) => {
      socket.setTimeout(0);
      sockets.add(socket);
      socket.on("close", () => { sockets.delete(socket); client.destroy(); });
      socket.on("error", () => client.destroy());
      client.on("close", () => socket.destroy());
      client.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`);
      if (buffered.length) client.write(buffered);
      if (head.length) socket.write(head);
      socket.pipe(client).pipe(socket);
    });
    upstream.on("response", () => { upstream.destroy(); client.destroy(); });
    upstream.on("error", () => client.destroy());
    upstream.setTimeout(10000, () => upstream.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
    upstream.end();
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    setTarget(value) {
      target = value;
      for (const client of streams) client.destroy();
      for (const { upstream, res, req, cors } of requests) {
        if (res.writableEnded) continue;
        req.unpipe(upstream);
        req.resume();
        if (!res.headersSent) res.writeHead(503, { ...cors, "content-type": "application/json" }).end(JSON.stringify({ error: "The SSH connection changed. Try again after reconnecting." }));
        else res.destroy();
        upstream.destroy();
      }
      requests.clear();
    },
    close() { target = undefined; for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); },
  };
}
