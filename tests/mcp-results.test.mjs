import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";

const directory = await mkdtemp(join(tmpdir(), "citropy-mcp-results-"));
process.env.CITROPY_DATA_DIR = join(directory, "data");
const { store } = await import("../server/store.ts");
const { eventJournal } = await import("../server/event-journal.ts");
const { callWorkspaceTool, handleMcp } = await import("../server/mcp.ts");
const { connectTools } = await import("../server/mcp-access.ts");
const { providers } = await import("../server/providers/index.ts");
const { serveToolImage } = await import("../server/tool-images.ts");
const { assetPath } = await import("../server/assets.ts");
const { bus } = await import("../server/bus.ts");
const { answer } = await import("../server/permissions.ts");
const project = store.openProject(directory);
const parent = store.createThread({ projectId: project.id, provider: "codex", title: "Parent", permissionMode: "plan" });
const call = async (name, args = {}) => JSON.parse((await callWorkspaceTool(parent.id, name, args))[0].text);

test.after(async () => {
  store.flush();
  eventJournal.close();
  await rm(directory, { recursive: true, force: true });
});

test("MCP transport preserves authentication, request validation and tool-error envelopes", async t => {
  const server = createServer((request, response) => { void handleMcp(parent.id, request, response); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const credentials = connectTools(parent.id);
  const request = (body, options = {}) => fetch(endpoint, { method: "POST", headers: credentials.headers, body, ...options });

  assert.equal((await request("{}", { headers: {} })).status, 401);
  assert.equal((await request("{}", { headers: { ...credentials.headers, origin: "https://foreign.example" } })).status, 403);
  const unsupported = await request(undefined, { method: "GET" });
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.get("allow"), "POST, DELETE");
  assert.equal((await request(undefined, { method: "DELETE" })).status, 200);
  assert.equal((await request(" ".repeat(1024 * 1024 + 1))).status, 413);
  for (const [body, code] of [["{", -32700], ["null", -32600], ["[]", -32600], ['{"jsonrpc":"1.0"}', -32600]]) {
    const response = await request(body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, code);
  }
  assert.equal((await request(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).status, 202);
  const ping = await request(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }));
  assert.deepEqual(await ping.json(), { jsonrpc: "2.0", id: 0, result: {} });
  const unknown = await request(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "unknown" }));
  assert.equal((await unknown.json()).error.code, -32601);
  for (const args of [null, [], "invalid"]) {
    const response = await request(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "workspace_tree", arguments: args } }));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).result, { content: [{ type: "text", text: "Tool arguments must be an object" }], isError: true });
  }
});

test("workspace reads are bounded, page without gaps, and distinguish unreadable files", async () => {
  const content = "abc\n".repeat(12500);
  await writeFile(join(directory, "large.txt"), content);
  let result = await call("workspace_read", { path: "large.txt" });
  assert.equal(result.text.length, 16000);
  assert.equal(result.totalCharacters, content.length);
  let reconstructed = result.text;
  while (result.nextOffset !== undefined) {
    result = await call("workspace_read", { path: "large.txt", offset: result.nextOffset });
    reconstructed += result.text;
  }
  assert.equal(reconstructed, content);
  assert.equal((await call("workspace_read", { path: "large.txt", offset: 10, limit: 4 })).text, content.slice(10, 14));
  for (const args of [{ offset: -1 }, { offset: 0.5 }, { limit: 0 }, { limit: 16001 }, { limit: "100" }])
    await assert.rejects(call("workspace_read", { path: "large.txt", ...args }), /offset|limit/);
  await assert.rejects(call("workspace_read", { path: "missing" }), /Cannot read this file/);
  await assert.rejects(call("workspace_read", { path: "../outside" }), /inside this workspace/);
});

test("image sharing returns a durable conversation reference without vision tokens or arbitrary path access", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
  const path = join(directory, "published.png");
  await writeFile(path, png);
  const result = await call("run_tool", { name: "workspace_image", arguments: { path } });
  assert.match(result.id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.equal(result.markdown, `![Image](citropy-image:${result.id})`);
  assert.ok(JSON.stringify(result).length < 180);
  const stored = join(directory, "data", "tool-images", parent.id, `${result.id}.png`);
  assert.deepEqual(await readFile(stored), png);
  await rm(path);
  assert.deepEqual(await readFile(stored), png);
  const response = { status: 0, body: undefined, writeHead(status) { this.status = status; return this; }, end(body) { this.body = body; } };
  await serveToolImage({ method: "GET" }, response, new URLSearchParams({ threadId: parent.id, id: result.id }));
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, png);
  await serveToolImage({ method: "GET" }, response, new URLSearchParams({ threadId: "thr_other", id: result.id }));
  assert.equal(response.status, 404);
});

test("image sharing gates outside paths and symlink escapes without broadening asset access", async t => {
  const outside = await mkdtemp(join(tmpdir(), "citropy-shared-image-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const path = join(outside, "image.png");
  await writeFile(path, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
  const link = join(directory, "outside-image.png");
  await symlink(path, link);
  for (const image of [path, link])
    await assert.rejects(call("workspace_image", { path: image }), /outside the workspace.*Plan only/);
  const manual = store.createThread({ projectId: project.id, provider: "codex", title: "Image approval", permissionMode: "manual" });
  const requests = [];
  let decision = "deny";
  const unsubscribe = bus.subscribe(event => {
    if (event.t !== "permission.request" || event.request.threadId !== manual.id) return;
    requests.push(event.request);
    answer(event.request.id, decision);
  });
  t.after(unsubscribe);
  await assert.rejects(callWorkspaceTool(manual.id, "workspace_image", { path: link }), /Denied by the operator/);
  assert.equal(requests[0].tool, "mcp__citropy__workspace_image");
  assert.deepEqual(requests[0].input, { path });
  decision = "allow";
  const result = JSON.parse((await callWorkspaceTool(manual.id, "workspace_image", { path }))[0].text);
  assert.ok(result.id);
  await assert.rejects(assetPath(new URLSearchParams({ projectId: project.id, threadId: manual.id, path })), /outside this conversation/);
  store.removeThread(manual.id);
  await assert.rejects(readFile(join(directory, "data", "tool-images", manual.id, `${result.id}.png`)), { code: "ENOENT" });
  const bypass = store.createThread({ projectId: project.id, provider: "codex", title: "Full access image", permissionMode: "bypass" });
  assert.ok(JSON.parse((await callWorkspaceTool(bypass.id, "workspace_image", { path }))[0].text).id);
  store.removeThread(bypass.id);
});

test("image sharing rejects unsupported contents, oversized files, and directories", async () => {
  for (const [name, data, message] of [
    ["not-image.png", "Private text", /PNG, JPEG, GIF, or WebP/],
    ["active.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', /PNG, JPEG, GIF, or WebP/],
    ["huge.png", Buffer.alloc(8 * 1024 * 1024 + 1), /up to 8 MiB/],
  ]) {
    await writeFile(join(directory, name), data);
    await assert.rejects(call("workspace_image", { path: name }), message);
  }
  await assert.rejects(call("workspace_image", { path: directory }), /regular image file/);
});

test("subagent summaries omit repeated history while wait pages the current result", async () => {
  const child = store.createThread({ projectId: project.id, parentThreadId: parent.id, provider: "codex", title: "Review", permissionMode: "plan" });
  const message = (id, role, text) => ({ id, role, ts: Date.now(), parts: [{ kind: "text", id: `${id}-text`, text }] });
  child.messages.push(message("request", "user", "Do this task".repeat(2000)), message("progress", "assistant", "Checking"), message("result", "assistant", "Final result\n".repeat(2000)));
  const listed = await call("subagent_list");
  assert.equal(listed.find(entry => entry.id === child.id).messages, undefined);
  assert.ok(JSON.stringify(listed).length < 400);
  let result = (await call("subagent_wait", { id: child.id, timeoutMs: 0 })).messages[0];
  assert.equal(result.id, "result");
  assert.equal(result.role, "assistant");
  assert.equal(result.text.length, 16000);
  let reconstructed = result.text;
  while (result.nextOffset !== undefined) {
    result = (await call("subagent_wait", { id: child.id, timeoutMs: 0, offset: result.nextOffset })).messages[0];
    reconstructed += result.text;
  }
  assert.equal(reconstructed, child.messages.at(-1).parts[0].text);
  child.messages.push(message("followup", "user", "Check again"));
  assert.deepEqual((await call("subagent_wait", { id: child.id, timeoutMs: 0 })).messages, []);
  child.nativeAgentId = "native-worker";
  assert.equal((await call("subagent_list"))[0].nativeAgentId, "native-worker");
  child.status = "error";
  child.error = "Provider could not start";
  assert.equal((await call("subagent_list"))[0].error, child.error);
  assert.equal((await call("subagent_wait", { id: child.id, timeoutMs: 0 })).error, child.error);
});

test("invalid subagent model and effort return usable options without creating a child", async t => {
  const provider = providers.codex;
  const original = { models: provider.models, detect: provider.detect };
  t.after(() => Object.assign(provider, original));
  provider.detect = async () => ({ available: true });
  provider.models = Array.from({ length: 20 }, (_, index) => ({ id: `model-${index}`, label: `Model ${index}`, efforts: index === 0 ? ["low", "high"] : undefined }));
  const before = store.threads.size;
  await assert.rejects(call("subagent_start", { title: "Task", task: "Review", model: "guessed-model" }), error => {
    assert.match(error.message, /Available model IDs \(first 12 of 20\): model-0, model-1,/);
    assert.match(error.message, /model-11\. Omit model/);
    assert.doesNotMatch(error.message, /model-12/);
    return true;
  });
  await assert.rejects(call("subagent_start", { title: "Task", task: "Review", model: "model-0", effort: "unknown" }), /Supported efforts: low, high\. Omit effort/);
  await assert.rejects(call("subagent_start", { title: "Task", task: "Review", model: "model-1", effort: "unknown" }), /Supported efforts: none for this model\. Omit effort/);
  assert.equal(store.threads.size, before);
});
