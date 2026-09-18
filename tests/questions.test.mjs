import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";

const root = await mkdtemp(join(tmpdir(), "citropy-questions-"));
process.env.CITROPY_DATA_DIR = join(root, "data");
const { store } = await import("../server/store.ts");
const { eventJournal } = await import("../server/event-journal.ts");
const { askQuestion, answerQuestion, pendingQuestions, cancelQuestions } = await import("../server/questions.ts");
const { normalizeQuestions } = await import("../shared/questions.ts");
const { callWorkspaceTool, workspaceTools, handleMcp } = await import("../server/mcp.ts");
const { connectTools } = await import("../server/mcp-access.ts");
const { handleFeatures } = await import("../server/features.ts");
const { pendingRequests } = await import("../server/permissions.ts");
const { providers } = await import("../server/providers/index.ts");
const { runtimeFor, disposeAll } = await import("../server/runtime.ts");
const { historyPrompt } = await import("../server/checkpoints.ts");
const project = store.openProject(root);
const create = (provider = "opencode", permissionMode = "plan") => {
  const thread = store.createThread({ projectId: project.id, provider, title: "Questions", permissionMode });
  store.patchThread(thread.id, { running: true, status: "thinking" });
  return thread;
};
const questions = [{ id: "scope", question: "Who should be able to join?", options: [{ label: "Just me", description: "Start with single player." }, { label: "Friends" }] }, { id: "features", question: "What matters most?", multiple: true, options: [{ label: "Building" }, { label: "Exploring" }] }];
const until = async check => { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error("Question state did not settle"); };

test.after(async () => {
  for (const thread of store.threads.values()) cancelQuestions(thread.id);
  disposeAll();
  store.flush();
  eventJournal.close();
  await rm(root, { recursive: true, force: true });
});

test("questions validate input, require deliberate answers and preserve readable history", async () => {
  assert.throws(() => normalizeQuestions([]), /one and four/);
  assert.throws(() => normalizeQuestions([{ question: "" }]), /readable/);
  assert.throws(() => normalizeQuestions([{ id: "__proto__", question: "Test" }]), /identifier/);
  assert.throws(() => normalizeQuestions([{ question: "Test", options: [{ label: "A" }, { label: "A" }] }]), /different label/);
  const thread = create();
  const waiting = askQuestion(thread.id, questions, { id: "roundtrip" });
  assert.equal(askQuestion(thread.id, questions, { id: "roundtrip" }), waiting);
  assert.equal(thread.status, "awaiting");
  assert.equal(pendingRequests().length, 0);
  assert.throws(() => answerQuestion("other", "roundtrip", { scope: ["Just me"], features: ["Building"] }), /no longer/);
  assert.throws(() => answerQuestion(thread.id, "roundtrip", {}), /each question/);
  assert.throws(() => answerQuestion(thread.id, "roundtrip", { scope: ["Just me", "Friends"], features: ["Building"] }), /each question/);
  assert.equal(pendingQuestions().length, 1);
  const answers = { scope: ["Something else entirely"], features: ["Building", "Exploring", " Offline first "] };
  answerQuestion(thread.id, "roundtrip", answers);
  assert.deepEqual(await waiting, { cancelled: false, answers: { ...answers, features: ["Building", "Exploring", "Offline first"] } });
  assert.equal(thread.status, "working");
  assert.equal(thread.messages[0].parts[0].status, "answered");
  assert.match(historyPrompt(thread.messages, "Continue"), /Something else entirely/);
  assert.throws(() => answerQuestion(thread.id, "roundtrip", answers), /no longer/);
});

test("skip, disconnect, stop and secret questions settle without invented answers", async () => {
  const thread = create();
  const secret = askQuestion(thread.id, [{ id: "secret", question: "Access code?", secret: true }]);
  answerQuestion(thread.id, pendingQuestions()[0].id, { secret: ["sensitive-value"] });
  assert.equal((await secret).answers.secret[0], "sensitive-value");
  assert.equal(thread.messages[0].parts[0].answers.secret[0], "••••••");
  const skipped = askQuestion(thread.id, questions);
  answerQuestion(thread.id, pendingQuestions()[0].id, null);
  assert.deepEqual(await skipped, { cancelled: true, answers: {} });
  const controller = new AbortController();
  const disconnected = askQuestion(thread.id, questions, { signal: controller.signal });
  controller.abort();
  assert.equal((await disconnected).cancelled, true);
  const stopped = askQuestion(thread.id, questions);
  runtimeFor(thread.id).stop();
  assert.equal((await stopped).cancelled, true);
  assert.equal(thread.status, "stopped");
  assert.deepEqual(pendingQuestions(), []);
  assert.equal((await askQuestion(thread.id, questions)).cancelled, true);
});

test("all providers can use the shared tool in every access mode, including Claude's native question callback", async () => {
  assert.ok(workspaceTools.some(tool => tool.name === "ask_user"));
  for (const provider of ["claude", "codex", "opencode"]) for (const mode of ["plan", "manual", "bypass"]) {
    const thread = create(provider, mode);
    const result = callWorkspaceTool(thread.id, "ask_user", { questions: [{ question: "Name it?" }] });
    const request = pendingQuestions()[0];
    answerQuestion(thread.id, request.id, { question_1: ["Citropy"] });
    assert.deepEqual(JSON.parse((await result)[0].text), { cancelled: false, answers: { question_1: ["Citropy"] } });
  }
  const thread = create("claude");
  const native = callWorkspaceTool(thread.id, "approve", { tool_name: "AskUserQuestion", input: { questions: [{ question: "Features?", header: "Features", options: [{ label: "A" }, { label: "B" }], multiSelect: true }] } });
  answerQuestion(thread.id, pendingQuestions()[0].id, { question_1: ["A", "B"] });
  const response = JSON.parse((await native)[0].text);
  assert.equal(response.behavior, "allow");
  assert.deepEqual(response.updatedInput.answers, { "Features?": "A, B" });
  assert.equal(pendingRequests().length, 0);
});

test("runtime updates cannot replace the waiting state and completion clears abandoned questions", async t => {
  const original = providers.opencode.start;
  let emit;
  providers.opencode.start = options => {
    emit = options.emit;
    return { send() {}, interrupt() { emit({ type: "turn.end" }); }, dispose() {} };
  };
  t.after(() => { providers.opencode.start = original; });
  const thread = create();
  store.patchThread(thread.id, { running: false, status: "idle" });
  const runtime = runtimeFor(thread.id);
  await runtime.send("Test awaiting input");
  const waiting = askQuestion(thread.id, questions);
  emit({ type: "status", status: "working", tool: "question" });
  assert.equal(thread.status, "awaiting");
  assert.equal(thread.activeTool, undefined);
  emit({ type: "turn.end", error: "Disconnected" });
  assert.equal((await waiting).cancelled, true);
  assert.equal(thread.running, false);
  assert.equal(thread.status, "error");
  assert.equal(pendingQuestions().length, 0);
  runtime.dispose(true);
});

test("the authenticated MCP call waits for the answer endpoint and cleans up on disconnection", async t => {
  const thread = create();
  const access = connectTools(thread.id);
  const server = http.createServer(async (req, res) => {
    if (req.url === "/mcp") await handleMcp(thread.id, req, res);
    else if (!await handleFeatures(req, res, [])) res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const invoke = signal => fetch(`${base}/mcp`, { method: "POST", headers: access.headers, signal, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_user", arguments: { questions: [{ question: "Use a local save?" }] } } }) });
  const running = invoke();
  await until(() => pendingQuestions().length === 1);
  const reply = await fetch(`${base}/api/threads/question?threadId=${thread.id}`, { method: "POST", body: JSON.stringify({ id: pendingQuestions()[0].id, answers: { question_1: ["Yes"] } }) });
  assert.equal(reply.status, 200);
  assert.deepEqual(JSON.parse((await (await running).json()).result.content[0].text).answers, { question_1: ["Yes"] });
  const controller = new AbortController();
  const abandoned = invoke(controller.signal).catch(error => error);
  await until(() => pendingQuestions().length === 1);
  controller.abort();
  await abandoned;
  await until(() => pendingQuestions().length === 0);
});

test("Codex native user input returns its wire format and rejects a foreign task", async t => {
  const original = childProcess.spawn;
  const sent = [];
  let child;
  childProcess.spawn = () => {
    child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => true;
    child.stdin.on("data", data => {
      const message = JSON.parse(String(data)); sent.push(message);
      if (message.method && message.id !== undefined) queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: message.id, result: { thread: { id: "native" } } })}\n`));
    });
    return child;
  };
  syncBuiltinESMExports();
  const thread = create("codex");
  const session = providers.codex.start({ threadId: thread.id, cwd: root, permissionMode: "manual", emit() {} });
  t.after(() => { session.dispose(); childProcess.spawn = original; syncBuiltinESMExports(); });
  await until(() => sent.some(message => message.method === "thread/start"));
  await new Promise(resolve => setImmediate(resolve));
  const request = (id, threadId = "native") => child.stdout.write(`${JSON.stringify({ id, method: "item/tool/requestUserInput", params: { threadId, itemId: "item", questions: [{ id: "scope", header: "Scope", question: "Which scope?", options: [{ label: "Local", description: "Keep data here" }] }] } })}\n`);
  request("foreign", "other");
  await until(() => sent.some(message => message.id === "foreign"));
  assert.equal(sent.find(message => message.id === "foreign").error.code, -32602);
  request("question");
  await until(() => pendingQuestions().length === 1);
  answerQuestion(thread.id, pendingQuestions()[0].id, { scope: ["Local"] });
  await until(() => sent.some(message => message.id === "question"));
  assert.deepEqual(sent.find(message => message.id === "question").result, { answers: { scope: { answers: ["Local"] } } });
  request("skip");
  await until(() => pendingQuestions().length === 1);
  answerQuestion(thread.id, pendingQuestions()[0].id, null);
  await until(() => sent.some(message => message.id === "skip"));
  assert.deepEqual(sent.find(message => message.id === "skip").result, { answers: {} });
});

test("OpenCode native questions reply, reject and ignore duplicate or unrelated events", async t => {
  const original = childProcess.spawn;
  let stream;
  let prompt;
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === "/event") { stream = res; res.writeHead(200, { "content-type": "text/event-stream" }); res.write(":ready\n\n"); return; }
    let body = ""; for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, input: JSON.parse(body || "{}") });
    res.setHeader("content-type", "application/json");
    if (req.url === "/session") res.end(JSON.stringify({ id: "native" }));
    else if (req.url === "/session/native/message") prompt = res;
    else res.end("true");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  childProcess.spawn = (_binary, _args, options) => {
    assert.equal(JSON.parse(options.env.OPENCODE_CONFIG_CONTENT).permission.question, "allow");
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    queueMicrotask(() => child.stdout.write(`http://127.0.0.1:${server.address().port}\n`));
    return child;
  };
  syncBuiltinESMExports();
  const thread = create();
  const session = providers.opencode.start({ threadId: thread.id, cwd: root, permissionMode: "plan", emit() {} });
  t.after(async () => { session.dispose(); stream?.end(); prompt?.end("false"); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); childProcess.spawn = original; syncBuiltinESMExports(); });
  await until(() => stream);
  session.send("Ask me");
  await until(() => prompt);
  const notify = (type, props) => stream.write(`data: ${JSON.stringify({ type, properties: { sessionID: "native", ...props } })}\n\n`);
  notify("question.asked", { id: "invalid", questions: [] });
  await until(() => requests.some(request => request.path === "/question/invalid/reject"));
  assert.equal(pendingQuestions().length, 0);
  notify("question.asked", { id: "outside", sessionID: "other", questions });
  notify("question.asked", { id: "native-question", questions });
  notify("question.asked", { id: "native-question", questions });
  await until(() => pendingQuestions().length === 1);
  answerQuestion(thread.id, pendingQuestions()[0].id, { scope: ["Friends"], features: ["Building", "Exploring"] });
  await until(() => requests.some(request => request.path === "/question/native-question/reply"));
  assert.deepEqual(requests.find(request => request.path === "/question/native-question/reply").input, { answers: [["Friends"], ["Building", "Exploring"]] });
  notify("question.asked", { id: "skip", questions });
  await until(() => pendingQuestions().length === 1);
  answerQuestion(thread.id, pendingQuestions()[0].id, null);
  await until(() => requests.some(request => request.path === "/question/skip/reject"));
  notify("question.asked", { id: "external", questions: [{ question: "Externally answered?" }] });
  await until(() => pendingQuestions().length === 1);
  notify("question.replied", { requestID: "external", answers: [["Yes"]] });
  await until(() => pendingQuestions().length === 0);
  assert.equal(requests.some(request => request.path === "/question/external/reply"), false);
});
