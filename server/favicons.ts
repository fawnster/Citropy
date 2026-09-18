import type { ServerResponse } from "node:http";

const pageLimit = 512 * 1024;
const iconLimit = 512 * 1024;
const hitTtl = 6 * 60 * 60 * 1000;
const missTtl = 5 * 60 * 1000;
const cacheLimit = 200;

interface Entry {
  at: number;
  type?: string;
  body?: Buffer;
}

const cache = new Map<string, Entry>();

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "i").exec(tag);
  return match?.[1]?.replace(/^["']|["']$/g, "");
}

function iconLinks(html: string, base: string): string[] {
  const links: string[] = [];
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = attribute(match[0], "rel") ?? "";
    if (!rel.split(/\s+/).some((token) => token.toLowerCase().includes("icon"))) continue;
    const href = attribute(match[0], "href");
    if (!href) continue;
    try {
      links.push(new URL(href, base).href);
    } catch {}
  }
  return links;
}

async function read(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error("Response is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function download(
  url: string,
  accept: string,
  limit: number,
  timeout: number,
): Promise<{ url: string; type: string; body: Buffer }> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeout),
    headers: { accept, "user-agent": "Citropy" },
  });
  if (!response.ok) throw new Error("Request failed");
  return {
    url: response.url,
    type: (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase(),
    body: await read(response, limit),
  };
}

function isIcon(type: string, url: string): boolean {
  if (type.startsWith("image/")) return true;
  return /\.(ico|png|svg|gif|jpe?g|webp|avif)$/i.test(new URL(url).pathname);
}

export async function faviconFor(href: string): Promise<{ type: string; body: Buffer } | undefined> {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  if (!["http:", "https:"].includes(url.protocol)) return undefined;
  const cached = cache.get(url.origin);
  if (cached && Date.now() - cached.at < (cached.body ? hitTtl : missTtl))
    return cached.body ? { type: cached.type!, body: cached.body } : undefined;
  const page = await download(url.href, "text/html,application/xhtml+xml", pageLimit, 5000).catch(() => undefined);
  const candidates = [
    ...new Set([
      ...(page?.type.includes("html") ? iconLinks(page.body.toString("utf8"), page.url) : []),
      new URL("/favicon.ico", url).href,
    ]),
  ];
  let found: { type: string; body: Buffer } | undefined;
  for (const candidate of candidates) {
    const icon = await download(candidate, "image/*,*/*;q=0.8", iconLimit, 4000).catch(() => undefined);
    if (icon && isIcon(icon.type, icon.url)) {
      found = { type: icon.type, body: icon.body };
      break;
    }
  }
  if (cache.size >= cacheLimit) cache.delete(cache.keys().next().value!);
  cache.set(url.origin, found ? { at: Date.now(), ...found } : { at: Date.now() });
  return found;
}

export async function serveFavicon(res: ServerResponse, params: URLSearchParams): Promise<void> {
  const icon = await faviconFor(params.get("url") ?? "").catch(() => undefined);
  if (!icon) {
    res.writeHead(404, { "cache-control": "private, max-age=300" }).end();
    return;
  }
  res.writeHead(200, {
    "content-type": icon.type || "image/x-icon",
    "content-length": icon.body.length,
    "cache-control": "private, max-age=21600",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'; img-src data:",
  });
  res.end(icon.body);
}
