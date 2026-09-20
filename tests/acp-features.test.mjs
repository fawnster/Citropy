import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));

test("the ACP provider drives a fake Cursor agent", { timeout: 120_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-acp-"));
  const log = join(directory, "fake.log");
  const binary = join(directory, "cursor-agent");
  await writeFile(binary, `#!/bin/sh\nexec node ${JSON.stringify(fixture)} "$@"\n`, { mode: 0o755 });
  await chmod(binary, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${directory}:${originalPath}`;
  process.env.FAKE_ACP_LOG = log;
  process.env.CITROPY_DATA_DIR = join(directory, "data");

  const { cursorProvider, cursorConfig, cursorCommands } = await import("../server/providers/cursor.ts");
  const { acpModels } = await import("../server/providers/acp.ts");
  const { answer, pendingRequests } = await import("../server/permissions.ts");
  const { pendingQuestions, answerQuestion } = await import("../server/questions.ts");
  const { store } = await import("../server/store.ts");

  t.after(async () => {
    process.env.PATH = originalPath;
    delete process.env.FAKE_ACP_LOG;
    delete process.env.CITROPY_DATA_DIR;
    store.flush();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rm(directory, { recursive: true, force: true });
  });

  const waitFor = async (predicate, message, timeout = 20_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${message}`);
  };
  const entries = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

  assert.deepEqual(await cursorProvider.detect(), { available: true, version: "fake-cursor 1.0.0" });
  assert.equal(cursorProvider.capabilities.steer, false);
  assert.equal(cursorProvider.capabilities.compact, false);

  const models = await acpModels(cursorConfig);
  assert.deepEqual(
    models.map((model) => [model.id, model.label, model.defaultEffort, model.efforts, model.contextWindows, model.contextMax, model.fastMode]),
    [
      ["default", "Auto", undefined, [], undefined, undefined, false],
      ["fake-fast", "Fake Fast", "low", ["low", "high"], undefined, undefined, true],
      ["fake-smart", "Fake Smart", "medium", ["none", "low", "medium", "high", "xhigh"], [300000, 1000000], 300000, false],
    ],
  );
  assert.equal((await entries()).some((entry) => entry.method === "initialize" && entry.parameterized === true), true);
  assert.equal((await entries()).some((entry) => entry.method === "session/new"), false);

  const project = store.openProject(directory);
  const thread = store.createThread({ projectId: project.id, provider: "cursor", title: "ACP", permissionMode: "manual" });
  store.patchThread(thread.id, { running: true, status: "working" });

  const events = [];
  const session = cursorProvider.start({
    threadId: thread.id,
    cwd: directory,
    permissionMode: "manual",
    contextMax: 200000,
    mcp: { url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer test-token" } },
    emit: (event) => events.push(event),
  });
  t.after(() => session.dispose());
  await waitFor(() => events.some((event) => event.type === "session"), "the session handshake");
  const picture = join(directory, "picture.png");
  const notes = join(directory, "notes.txt");
  await writeFile(picture, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await writeFile(notes, "Notes for the agent.");
  session.send("hello", [
    { path: picture, label: "picture.png", mime: "image/png" },
    { path: notes, label: "notes.txt", mime: "text/plain" },
  ]);
  const sent = await waitFor(async () => (await entries()).find((entry) => entry.method === "session/prompt"), "the prompt to reach the agent");
  assert.equal(sent.text, "hello");
  assert.equal(sent.images, 1);
  assert.equal(sent.links, 1);
  const question = await waitFor(() => pendingQuestions().find((entry) => entry.threadId === thread.id), "the Cursor question");
  assert.equal(question.questions[0].question, "Which check should run?");
  answerQuestion(thread.id, question.id, { check: ["Fast"] });
  const planQuestion = await waitFor(() => pendingQuestions().find((entry) => entry.threadId === thread.id && entry.questions[0].id === "plan"), "the plan approval");
  assert.equal(planQuestion.questions[0].header, "Checks");
  assert.match(events.filter((event) => event.type === "block.delta").map((event) => event.text).join(""), /Run the checks\./);
  answerQuestion(thread.id, planQuestion.id, { plan: ["Accept the plan"] });
  const permission = await waitFor(() => pendingRequests().find((entry) => entry.threadId === thread.id), "the permission prompt");
  assert.equal(permission.tool, "Bash");
  assert.deepEqual(permission.input, { command: "npm test" });
  answer(permission.id, "allow");
  const end = await waitFor(() => events.find((event) => event.type === "turn.end"), "the first turn to finish");
  assert.equal(end.error, undefined);

  const sessionEvent = events.find((event) => event.type === "session");
  assert.match(sessionEvent.externalId, /^fake-/);
  assert.equal(sessionEvent.contextMax, 200000);
  const reasoning = events.filter((event) => event.type === "block.delta").map((event) => event.text).join("");
  assert.match(reasoning, /Checking the request\./);
  assert.match(reasoning, /Working on it\./);
  assert.match(reasoning, /Done\./);
  assert.deepEqual((await entries()).find((entry) => entry.method === "mcp-permission").outcome, { outcome: "selected", optionId: "allow-once" });
  assert.equal(events.find((event) => event.type === "tool.input" && event.callId === "mcp-1").name, "mcp__citropy__ask_user");
  assert.equal(events.some((event) => event.type === "tool.start" && event.callId === "plan-tool"), false);
  assert.equal(events.some((event) => event.type === "tool.start" && event.callId === "plan-late"), true);
  const latePlan = events.find((event) => event.type === "tool.end" && event.callId === "plan-late");
  assert.equal(latePlan?.ok, true);
  const blockOf = (text) => events.find((event) => event.type === "block.delta" && event.text === text).blockId;
  assert.notEqual(blockOf("Before tools."), blockOf("After tools."));
  const toolStart = events.find((event) => event.type === "tool.start" && event.callId === "tool-1");
  assert.equal(toolStart.name, "Bash");
  const toolEnd = events.find((event) => event.type === "tool.end" && event.callId === "tool-1");
  assert.equal(toolEnd.ok, true);
  assert.match(toolEnd.output, /All checks passed/);
  assert.deepEqual(toolEnd.images, [{ mime: "image/png", data: "aGVsbG8=" }]);
  const todos = events.filter((event) => event.type === "todos").at(-1);
  assert.deepEqual(todos.items.map((item) => [item.text, item.status]), [["Run the checks", "in_progress"], ["Report the result", "completed"]]);
  const usage = events.find((event) => event.type === "usage");
  assert.equal(usage.usage.contextTokens, 12000);
  assert.equal(usage.usage.contextMax, 200000);
  assert.equal(usage.usage.costUsd, 0.02);
  assert.equal(usage.usage.cacheRead, 4000);
  assert.equal(usage.usage.cacheWrite, 150);
  assert.equal(usage.usage.output, 300);
  const promptUsage = events.findLast((event) => event.type === "usage");
  assert.equal(promptUsage.usage.input, 2500);
  assert.equal(promptUsage.usage.output, 800);
  assert.equal(promptUsage.usage.cacheRead, 9000);
  assert.equal(promptUsage.usage.cacheWrite, 400);
  assert.equal(promptUsage.usage.contextTokens, undefined);
  assert.deepEqual(cursorCommands(directory).map((command) => [command.name, command.argumentHint]), [["simplify", "[path]"]]);
  const { listCommands } = await import("../server/commands.ts");
  const unpublished = join(directory, "fresh-workspace");
  assert.deepEqual(await listCommands("cursor", unpublished), []);
  cursorConfig.onCommands(unpublished, [{ name: "review", description: "Review my changes" }]);
  assert.deepEqual((await listCommands("cursor", unpublished)).map((command) => command.name), ["review"]);
  assert.deepEqual((await entries()).find((entry) => entry.method === "cursor/ask_question").outcome, { outcome: "answered", answers: [{ questionId: "check", selectedOptionIds: ["fast"] }] });
  assert.deepEqual((await entries()).find((entry) => entry.method === "cursor/create_plan").outcome, { outcome: "accepted" });
  assert.deepEqual((await entries()).find((entry) => entry.method === "permission").outcome, { outcome: "selected", optionId: "allow-once" });

  const started = (await entries()).find((entry) => entry.method === "session/new" && entry.cwd === directory);
  assert.deepEqual(started.mcpServers, [{ type: "http", name: "citropy", url: "http://127.0.0.1:9/mcp", headers: [{ name: "Authorization", value: "Bearer test-token" }] }]);

  process.env.FAKE_ACP_SIGNED_OUT = "1";
  t.after(() => { delete process.env.FAKE_ACP_SIGNED_OUT; });
  const signedOut = /Cursor is not signed in\. Run `cursor-agent login` in a terminal/;
  await assert.rejects(acpModels(cursorConfig), signedOut);
  const signedOutEvents = [];
  cursorProvider.start({ threadId: "acp-signed-out", cwd: directory, permissionMode: "manual", emit: (event) => signedOutEvents.push(event) });
  const notice = await waitFor(() => signedOutEvents.find((event) => event.type === "notice" && event.level === "error"), "the signed-out notice");
  assert.match(notice.text, signedOut);
  delete process.env.FAKE_ACP_SIGNED_OUT;
  assert.equal((await entries()).some((entry) => entry.method === "authenticate"), false);

  const bypassEvents = [];
  const bypass = cursorProvider.start({ threadId: "acp-bypass", cwd: directory, permissionMode: "bypass", emit: (event) => bypassEvents.push(event) });
  t.after(() => bypass.dispose());
  bypass.send("hello");
  await waitFor(() => bypassEvents.some((event) => event.type === "turn.end"), "the bypass turn to finish");
  assert.deepEqual((await entries()).filter((entry) => entry.method === "cursor/create_plan").at(-1).outcome, { outcome: "accepted" });
  assert.equal(pendingRequests().some((entry) => entry.threadId === "acp-bypass"), false);

  const planEvents = [];
  const planned = cursorProvider.start({ threadId: "acp-plan", cwd: directory, permissionMode: "plan", model: "fake-smart", effort: "xhigh", contextMax: 1_000_000, emit: (event) => planEvents.push(event) });
  t.after(() => planned.dispose());
  await waitFor(async () => (await entries()).some((entry) => entry.method === "session/set_mode" && entry.modeId === "plan"), "the plan mode switch");
  await waitFor(async () => (await entries()).some((entry) => entry.method === "session/set_config_option" && entry.configId === "model" && entry.value === "fake-smart"), "the model switch");
  await waitFor(async () => (await entries()).some((entry) => entry.method === "session/set_config_option" && entry.configId === "reasoning" && entry.value === "xhigh"), "the reasoning switch");
  await waitFor(async () => (await entries()).some((entry) => entry.method === "session/set_config_option" && entry.configId === "context" && entry.value === "1m"), "the context switch");
  const plannedSession = await waitFor(() => planEvents.find((event) => event.type === "session"), "the planned session");
  assert.equal(plannedSession.model, "fake-smart");
  assert.equal(plannedSession.contextMax, 1_000_000);

  const cancelEvents = [];
  const slow = cursorProvider.start({ threadId: "acp-cancel", cwd: directory, permissionMode: "manual", emit: (event) => cancelEvents.push(event) });
  t.after(() => slow.dispose());
  slow.send("slow work");
  await waitFor(async () => (await entries()).some((entry) => entry.method === "session/prompt" && entry.text.includes("slow")), "the slow prompt to start");
  slow.interrupt();
  const cancelled = await waitFor(() => cancelEvents.find((event) => event.type === "turn.end"), "the cancelled turn to finish");
  assert.equal(cancelled.error, undefined);
  await waitFor(async () => (await entries()).some((entry) => entry.method === "session/cancel"), "the cancel notification");
});
