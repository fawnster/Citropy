import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { faviconFor, serveFavicon } from "../server/favicons.ts";

const icon = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="blue"/></svg>';

function fixture(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` }),
    );
  });
}

test("favicons resolve declared icons, fall back to /favicon.ico, and report misses", async (t) => {
  const hits = [];
  const declared = await fixture((req, res) => {
    hits.push(req.url);
    if (req.url === "/assets/icon.svg") {
      res.writeHead(200, { "content-type": "image/svg+xml" }).end(icon);
      return;
    }
    if (req.url === "/favicon.ico") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end(`<html><head><link rel="shortcut icon" href="/assets/icon.svg"></head></html>`);
  });
  const fallback = await fixture((req, res) => {
    if (req.url === "/favicon.ico") {
      res.writeHead(200, { "content-type": "application/octet-stream" }).end(Buffer.from([0, 0, 1, 0]));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end("<html></html>");
  });
  const missing = await fixture((req, res) => {
    res.writeHead(404).end();
  });
  t.after(() => {
    declared.server.close();
    fallback.server.close();
    missing.server.close();
  });

  const first = await faviconFor(`${declared.url}/page?q=1`);
  assert.equal(first?.type, "image/svg+xml");
  assert.equal(first?.body.toString(), icon);
  const again = await faviconFor(`${declared.url}/another/page`);
  assert.equal(again?.body.toString(), icon);
  assert.equal(hits.filter((url) => url === "/page?q=1").length, 1);
  assert.equal(hits.includes("/another/page"), false);

  const second = await faviconFor(fallback.url);
  assert.equal(second?.type, "application/octet-stream");
  assert.equal(second?.body.length, 4);

  assert.equal(await faviconFor(missing.url), undefined);
  assert.equal(await faviconFor("mailto:hello@example.test"), undefined);
  assert.equal(await faviconFor("not a url"), undefined);
});

test("serveFavicon writes the icon bytes and a cacheable miss", async (t) => {
  const hit = await fixture((req, res) => {
    if (req.url === "/icon.svg") {
      res.writeHead(200, { "content-type": "image/svg+xml" }).end(icon);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end(`<link rel="icon" href="/icon.svg">`);
  });
  const miss = await fixture((req, res) => {
    res.writeHead(404).end();
  });
  t.after(() => {
    hit.server.close();
    miss.server.close();
  });

  const calls = [];
  const stub = () => {
    const call = { status: 0, headers: {}, body: undefined };
    calls.push(call);
    return {
      writeHead(status, headers) {
        call.status = status;
        Object.assign(call.headers, headers);
        return this;
      },
      end(body) {
        call.body = body;
      },
    };
  };

  await serveFavicon(stub(), new URLSearchParams({ url: `${hit.url}/guide` }));
  assert.equal(calls[0].status, 200);
  assert.equal(calls[0].headers["content-type"], "image/svg+xml");
  assert.equal(calls[0].body.toString(), icon);

  await serveFavicon(stub(), new URLSearchParams({ url: `${miss.url}/page` }));
  assert.equal(calls[1].status, 404);
  assert.match(calls[1].headers["cache-control"], /max-age/);
});

test("the favicon route is served through the feature handler", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "citropy-favicon-route-"));
  process.env.CITROPY_DATA_DIR = join(data, "data");
  const { handleFeatures } = await import("../server/features.ts");
  const { store } = await import("../server/store.ts");

  const site = await fixture((req, res) => {
    if (req.url === "/icon.svg") {
      res.writeHead(200, { "content-type": "image/svg+xml" }).end(icon);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end('<link rel="icon" href="/icon.svg">');
  });
  const app = createServer((req, res) => {
    void handleFeatures(req, res, []).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    store.flush();
    for (const server of [app, site.server]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    delete process.env.CITROPY_DATA_DIR;
    await rm(data, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${app.address().port}`;
  const response = await fetch(`${base}/api/favicon?url=${encodeURIComponent(`${site.url}/docs`)}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/svg+xml");
  assert.equal(await response.text(), icon);
  assert.equal((await fetch(`${base}/api/nothing`)).status, 404);
});
