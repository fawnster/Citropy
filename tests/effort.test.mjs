import assert from "node:assert/strict";
import { test } from "node:test";
import childProcess from "node:child_process";
import os from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("Codex app-server streams turns, resumes, reports usage and routes approvals to the user", async () => {
  const directory = mkdtempSync(join(os.tmpdir(), "citropy-effort-"));
  const originalSpawn = childProcess.spawn;
  const originalHomedir = os.homedir;
  const invocations = [];
  os.homedir = () => directory;
  childProcess.spawn = (binary, args, settings) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit("close", 0)); return true; };
    const messages = [];
    child.stdin.on("data", (data) => messages.push(JSON.parse(String(data))));
    invocations.push({ binary, args, settings, child, messages });
    return child;
  };
  syncBuiltinESMExports();
  const sessions = [];
  try {
    const { claudeProvider } = await import("../server/providers/claude.ts");
    const { codexProvider } = await import("../server/providers/codex.ts");
    const { pendingRequests, answer } = await import("../server/permissions.ts");
    const events = [];
    const options = {
      threadId: "test",
      cwd: directory,
      model: "test-model",
      effort: "high",
      fastMode: true,
      contextMax: 1000000,
      permissionMode: "manual",
      mcp: {
        url: "http://127.0.0.1:4177/mcp/test",
        headers: { Authorization: "Bearer test-token" },
      },
      emit(event) {
        events.push(event);
      },
    };
    sessions.push(claudeProvider.start(options));
    assert.equal(
      invocations[0].args[invocations[0].args.indexOf("--effort") + 1],
      "high",
    );
    assert.deepEqual(
      JSON.parse(
        invocations[0].args[invocations[0].args.indexOf("--mcp-config") + 1],
      ).mcpServers.citropy,
      { type: "http", ...options.mcp },
    );
    assert.equal(
      invocations[0].args[invocations[0].args.indexOf("--model") + 1],
      "test-model[1m]",
    );
    assert.deepEqual(
      JSON.parse(
        invocations[0].args[invocations[0].args.indexOf("--settings") + 1],
      ),
      { fastMode: true },
    );
    assert.equal(
      invocations[0].settings.env.CLAUDE_CODE_DISABLE_1M_CONTEXT,
      "0",
    );
    const claudeWire = invocations[0];
    const image = { label: "image.png", path: join(directory, "image.png"), mime: "image/png", size: 3 };
    writeFileSync(image.path, "png");
    await sessions[0].send("Read these", [image, { label: "notes.txt", path: join(directory, "notes.txt"), mime: "text/plain" }], [{ name: "sample", path: join(directory, "SKILL.md") }]);
    const input = claudeWire.messages.at(-1).message.content;
    assert.equal(input[0].type, "image");
    assert.equal(Buffer.from(input[0].source.data, "base64").toString(), "png");
    assert.match(input[1].text, /notes.txt/);
    assert.match(input[2].text, /SKILL.md/);
    assert.equal(input.at(-1).text, "Read these");
    await sessions[0].send("/security-review", [image], [{ name: "sample", path: join(directory, "SKILL.md") }]);
    const commandInput = claudeWire.messages.at(-1).message.content;
    assert.equal(commandInput[0].text, "/security-review");
    assert.equal(commandInput[1].type, "image");
    assert.match(commandInput[2].text, /SKILL.md/);
    assert.equal(claudeWire.messages.at(-1).priority, undefined);
    await sessions[0].steer("Also check the tests");
    assert.equal(claudeWire.messages.at(-1).priority, "next");
    assert.equal(claudeWire.messages.at(-1).message.content.at(-1).text, "Also check the tests");
    claudeWire.child.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "task-a", name: "Agent", input: { description: "Review", prompt: "Read files" } }] } }) + "\n");
    claudeWire.child.stdout.write(JSON.stringify({ type: "stream_event", parent_tool_use_id: "task-a", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Child private stream" } } }) + "\n");
    claudeWire.child.stdout.write(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "task-a", content: "Reviewed" }] } }) + "\n");
    assert.equal(events.findLast((event) => event.type === "subagent").result, "Reviewed");
    assert.equal(events.some((event) => event.type === "block.delta"), false);
    claudeWire.child.stdout.write(JSON.stringify({ type: "system", subtype: "task_started", task_id: "bash-task", tool_use_id: "bash-a", task_type: "local_bash", description: "Check load" }) + "\n");
    claudeWire.child.stdout.write(JSON.stringify({ type: "system", subtype: "task_notification", task_id: "bash-task", tool_use_id: "bash-a", status: "completed", summary: "Check load" }) + "\n");
    assert.equal(events.some((event) => event.type === "subagent" && event.id === "bash-a"), false);
    claudeWire.child.stdout.write(JSON.stringify({ type: "system", subtype: "task_started", task_id: "nested-task", tool_use_id: "nested-a", task_type: "local_agent", description: "Nested review", prompt: "Look deeper" }) + "\n");
    claudeWire.child.stdout.write(JSON.stringify({ type: "system", subtype: "task_notification", task_id: "nested-task", tool_use_id: "nested-a", status: "completed", summary: "Looked" }) + "\n");
    assert.deepEqual(events.findLast((event) => event.type === "subagent"), { type: "subagent", id: "nested-a", title: "Nested review", prompt: "Look deeper", status: "idle", result: "Looked" });
    const codex = codexProvider.start(options);
    sessions.push(codex);
    const wire = invocations[1];
    const notify = (method, params) => wire.child.stdout.write(JSON.stringify({ method, params }) + "\n");
    const reply = async (method, result) => {
      const request = wire.messages.findLast((m) => m.method === method);
      assert.ok(request, method);
      wire.child.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
      await tick();
    };
    codex.send("Hello", [image, { label: "notes.txt", path: join(directory, "notes.txt") }], [{ name: "sample", path: join(directory, "SKILL.md") }]);
    assert.equal(wire.args[0], "app-server");
    assert.ok(wire.args.includes('mcp_servers.citropy.bearer_token_env_var="CITROPY_MCP_TOKEN"'));
    assert.equal(wire.settings.env.CITROPY_MCP_TOKEN, "test-token");
    await reply("initialize", {});
    const start = wire.messages.find((m) => m.method === "thread/start");
    assert.equal(start.params.serviceTier, "priority");
    assert.equal(start.params.approvalsReviewer, "user");
    assert.equal(start.params.approvalPolicy, "untrusted");
    assert.equal(start.params.sandbox, "read-only");
    await reply("thread/start", { thread: { id: "external" }, model: "test-model" });
    const turn = wire.messages.find((m) => m.method === "turn/start");
    assert.equal(turn.params.effort, "high");
    assert.equal(turn.params.serviceTier, "priority");
    assert.equal(turn.params.input[0].text, "Hello");
    assert.deepEqual(turn.params.input.slice(1).map((entry) => entry.type), ["localImage", "mention", "skill"]);
    await reply("turn/start", { turn: { id: "turn1" } });
    const steering = codex.steer("Also check the tests", [], [{ name: "sample", path: join(directory, "SKILL.md") }]);
    await tick();
    assert.deepEqual(wire.messages.findLast((m) => m.method === "turn/steer").params, {
      threadId: "external",
      expectedTurnId: "turn1",
      input: [{ type: "text", text: "Also check the tests", text_elements: [] }, { type: "skill", name: "sample", path: join(directory, "SKILL.md") }],
    });
    await reply("turn/steer", { turnId: "turn1" });
    await steering;
    notify("item/agentMessage/delta", { threadId: "external", itemId: "a", delta: "Hel" });
    notify("item/agentMessage/delta", { threadId: "external", itemId: "a", delta: "lo" });
    notify("item/completed", { threadId: "external", item: { id: "a", type: "agentMessage", text: "Hello" } });
    assert.equal(events.filter((e) => e.type === "block.delta").map((e) => e.text).join(""), "Hello");
    notify("item/completed", { threadId: "external", item: { id: "spawn", type: "subAgentActivity", kind: "started", agentThreadId: "child", agentPath: "/root/reviewer" } });
    notify("turn/started", { threadId: "child", turn: { id: "child-turn" } });
    notify("item/agentMessage/delta", { threadId: "child", itemId: "answer", delta: "Child answer" });
    notify("item/completed", { threadId: "child", item: { id: "answer", type: "agentMessage", text: "Child answer" } });
    notify("turn/completed", { threadId: "child", turn: { status: "completed" } });
    assert.equal(events.findLast((e) => e.type === "subagent").status, "idle");
    assert.equal(events.findLast((e) => e.type === "subagent").result, "Child answer");
    assert.equal(events.filter((e) => e.type === "block.delta").map((e) => e.text).join(""), "Hello");
    assert.equal(events.filter((e) => e.type === "turn.end").length, 0);
    notify("thread/tokenUsage/updated", { threadId: "external", tokenUsage: { total: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 60, cacheWriteInputTokens: 5 }, last: { totalTokens: 120 }, modelContextWindow: 1000 } });
    assert.deepEqual(events.find((e) => e.type === "usage").usage, { input: 100, output: 20, cacheRead: 60, cacheWrite: 5, codexTotals: { input: 100, output: 20, cacheRead: 60, cacheWrite: 5 }, contextTokens: 120, contextMax: 1000 });
    for (const [id, method, decision, expected] of [["approval1", "item/commandExecution/requestApproval", "allow", "accept"], ["approval2", "item/fileChange/requestApproval", "deny", "decline"]]) {
      wire.child.stdout.write(JSON.stringify({ id, method, params: { threadId: "external", itemId: "tool", command: "touch example" } }) + "\n");
      assert.equal(wire.messages.some((m) => m.id === id), false);
      const request = pendingRequests()[0];
      assert.ok(request);
      answer(request.id, decision);
      await tick();
      assert.deepEqual(wire.messages.find((m) => m.id === id).result, { decision: expected });
    }
    notify("turn/completed", { threadId: "external", turn: { id: "turn1", status: "completed" } });
    notify("warning", { threadId: "external", message: "Provider warning" });
    assert.equal(events.findLast((e) => e.type === "notice").text, "Provider warning");
    codex.send("Follow-up");
    await tick();
    assert.equal(invocations.length, 2);
    assert.equal(wire.messages.filter((m) => m.method === "turn/start").length, 2);
    await reply("turn/start", { turn: { id: "turn2" } });
    codex.send("Not started yet");
    codex.interrupt();
    assert.match(events.findLast((e) => e.type === "notice").text, /Stopped before Codex started your latest message/);
    assert.equal(wire.messages.find((m) => m.method === "turn/interrupt").params.turnId, "turn2");
    await reply("turn/interrupt", {});
    notify("turn/completed", { threadId: "external", turn: { id: "turn2", status: "interrupted" } });
    const compacting = codex.compact();
    await tick();
    await reply("thread/compact/start", {});
    await compacting;
    notify("turn/started", { threadId: "external", turn: { id: "compact1" } });
    notify("item/completed", { threadId: "external", turnId: "compact1", item: { type: "contextCompaction", id: "compact-item" } });
    notify("thread/compacted", { threadId: "external", turnId: "compact1" });
    assert.equal(events.filter((entry) => entry.type === "compacted").length, 0);
    notify("turn/completed", { threadId: "external", turn: { id: "compact1", status: "completed" } });
    assert.equal(events.filter((entry) => entry.type === "compacted").length, 1);
    codex.send("Continue after compaction");
    await tick();
    notify("turn/completed", { threadId: "external", turn: { id: "compact1", status: "completed" } });
    assert.equal(events.filter((entry) => entry.type === "turn.end").length, 2);
    await reply("turn/start", { turn: { id: "after-compact" } });
    notify("item/agentMessage/delta", { threadId: "external", itemId: "continued", delta: "Context retained" });
    notify("turn/completed", { threadId: "external", turn: { id: "after-compact", status: "completed" } });
    await sessions[0].compact();
    assert.equal(claudeWire.messages.at(-1).message.content.at(-1).text, "/compact");
    claudeWire.child.stdout.write(JSON.stringify({ type: "system", subtype: "compact_boundary", compact_metadata: { post_tokens: 42 } }) + "\n");
    assert.equal(events.filter((entry) => entry.type === "compacted").length, 1);
    claudeWire.child.stdout.write(JSON.stringify({ type: "result", is_error: false }) + "\n");
    assert.equal(events.filter((entry) => entry.type === "compacted").length, 2);
    const completedBeforeReview = events.filter(event => event.type === "turn.end").length;
    codex.send("/review");
    await tick();
    assert.deepEqual(wire.messages.findLast(message => message.method === "review/start").params, { threadId: "external", delivery: "inline", target: { type: "uncommittedChanges" } });
    await reply("review/start", { turn: { id: "review-turn" } });
    notify("item/agentMessage/delta", { threadId: "external", itemId: "review-result", delta: "No findings" });
    notify("turn/completed", { threadId: "external", turn: { id: "review-turn", status: "completed" } });
    assert.equal(events.filter(event => event.type === "turn.end").length, completedBeforeReview + 1);
    claudeWire.child.stdout.write(JSON.stringify({ type: "assistant", local_command_source: "context", uuid: "context-command", message: { id: "local-output", content: [{ type: "text", text: "Native context report" }], usage: { input_tokens: 0, output_tokens: 0 } } }) + "\n");
    assert.equal(events.findLast(event => event.type === "block.delta").text, "Native context report");
    codex.dispose();
    await tick();
    assert.equal(events.filter((e) => e.type === "turn.end").length, 4);
    assert.equal(
      events.some((e) => e.type === "exit"),
      false,
    );
    const resumed = codexProvider.start({
      ...options,
      fastMode: false,
      externalId: "external",
      usage: { input: 100, output: 20, cacheRead: 60 },
    });
    sessions.push(resumed);
    const resumeWire = invocations[2];
    resumeWire.child.stdout.write(JSON.stringify({ id: resumeWire.messages[0].id, result: {} }) + "\n");
    await tick();
    const resumeRequest = resumeWire.messages.find((m) => m.method === "thread/resume");
    assert.equal(resumeRequest.params.threadId, "external");
    assert.equal(resumeRequest.params.serviceTier, "default");
    assert.equal(resumeRequest.params.approvalsReviewer, "user");
    resumed.send("Resume");
    resumeWire.child.stdout.write(JSON.stringify({ id: resumeRequest.id, result: { thread: { id: "external" } } }) + "\n");
    await tick();
    resumeWire.child.stdout.write(JSON.stringify({ method: "thread/tokenUsage/updated", params: { threadId: "external", tokenUsage: { total: { inputTokens: 150, outputTokens: 30, cachedInputTokens: 80 }, last: { totalTokens: 60 }, modelContextWindow: 1000 } } }) + "\n");
    assert.equal(events.findLast((e) => e.type === "usage").usage.input, 150);
    const resumedTurn = resumeWire.messages.find((m) => m.method === "turn/start");
    resumeWire.child.stdout.write(JSON.stringify({ id: resumedTurn.id, error: { message: "Model unavailable" } }) + "\n");
    await tick();
    assert.equal(events.findLast((e) => e.type === "turn.end").error, "Model unavailable");
    const legacy = codexProvider.start({ ...options, fastModeTier: "fast" });
    sessions.push(legacy);
    const legacyWire = invocations[3];
    legacyWire.child.stdout.write(JSON.stringify({ id: legacyWire.messages[0].id, result: {} }) + "\n");
    await tick();
    assert.equal(legacyWire.messages.find((message) => message.method === "thread/start").params.serviceTier, "fast");
    resumed.send("Try again");
    await tick();
    resumeWire.child.stderr.write("App-server connection failed\n");
    resumeWire.child.emit("close", 1);
    await tick();
    assert.equal(events.findLast((e) => e.type === "turn.end").error, "App-server connection failed");
    assert.equal(events.filter((e) => e.type === "exit").length, 1);
  } finally {
    sessions.forEach((session) => session.dispose());
    childProcess.spawn = originalSpawn;
    os.homedir = originalHomedir;
    syncBuiltinESMExports();
    rmSync(directory, { recursive: true, force: true });
  }
});
