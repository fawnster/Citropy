import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const directory = mkdtempSync(join(tmpdir(), "citropy-journal-test-"));
process.env.CITROPY_DATA_DIR = directory;
const { EventJournal, eventJournal } = await import("../server/event-journal.ts");
const { emptyUsage } = await import("../shared/protocol.ts");
const { validateAgentEvent, receiveAgentEvent, protocolLog } = await import("../server/providers/events.ts");
const { Bus } = await import("../server/bus.ts");

const thread = { id: "thread", projectId: "project", provider: "opencode", title: "Test", createdAt: 1, updatedAt: 1, status: "idle", permissionMode: "manual", usage: emptyUsage(), running: false };

test("durable events recover text without a snapshot flush and preserve imported ordering", async () => {
  const path = join(directory, "durability.sqlite");
  let journal = new EventJournal(path);
  journal.importThreads([{ ...thread, messages: Array.from({ length: 20 }, (_, index) => ({ id: `old${index}`, role: "user", ts: index, parts: [{ id: `oldpart${index}`, kind: "text", text: "Original" }] })) }]);
  journal.append({ t: "message.add", threadId: thread.id, message: { id: "new", role: "assistant", ts: 30, parts: [] } });
  journal.append({ t: "part.add", threadId: thread.id, messageId: "new", part: { id: "part", kind: "text", text: "" } });
  const sequence = journal.append({ t: "part.append", threadId: thread.id, messageId: "new", partId: "part", text: "Recovered" });
  journal.close();
  journal = new EventJournal(path);
  assert.equal(journal.threads()[0].messages.at(-1).parts[0].text, "Recovered");
  assert.deepEqual(journal.replay(sequence - 1).map(event => event.sequence), [sequence]);
  journal.append({ t: "thread.remove", id: thread.id });
  journal.importThreads([{ ...thread, messages: [] }]);
  assert.deepEqual(journal.threads(), []);
  journal.close();
});

test("receipts deduplicate concurrent retries and preserve outcomes across restarts", async () => {
  const path = join(directory, "receipts.sqlite");
  let journal = new EventJournal(path);
  let calls = 0;
  const input = { t: "thread.send", text: "Hello" };
  const action = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return [{ t: "thread.accepted", requestId: "request" }]; };
  const results = await Promise.all([journal.request("request", input, action), journal.request("request", input, action)]);
  assert.equal(calls, 1);
  assert.deepEqual(results[0], results[1]);
  journal.close();
  journal = new EventJournal(path);
  assert.deepEqual(await journal.request("request", input, action), results[0]);
  assert.equal(calls, 1);
  await assert.rejects(journal.request("request", { text: "Different" }, action), /another action/);
  journal.close();
});

test("replay cursors keep increasing when the byte budget evicts the entire event window", () => {
  const journal = new EventJournal(":memory:");
  for (let index = 0; index < 499; index++) journal.append({ t: "toast", level: "info", text: "Small event" });
  journal.append({ t: "toast", level: "info", text: "x".repeat(9 * 1024 * 1024) });
  assert.equal(journal.sequence, 500);
  assert.equal(journal.replay(499), null);
  assert.deepEqual(journal.replay(500), []);
  assert.equal(journal.append({ t: "toast", level: "info", text: "Next event" }), 501);
  assert.equal(journal.replay(500)[0].sequence, 501);
  journal.close();
});

test("nested events stay ordered and listeners cannot receive mutated tool input", () => {
  const bus = new Bus();
  const received = [];
  bus.subscribe(event => { if (event.text === "first") bus.emit({ t: "toast", level: "info", text: "second" }); });
  bus.subscribe(event => received.push(event.text));
  bus.emit({ t: "toast", level: "info", text: "first" });
  assert.deepEqual(received, ["first", "second"]);
});

test("provider boundaries normalize plans and reject malformed lifecycle events", () => {
  assert.deepEqual(validateAgentEvent({ type: "todos", items: [{ content: "Read file", status: "in_progress" }] }), { type: "todos", items: [{ text: "Read file", status: "in_progress" }] });
  assert.throws(() => validateAgentEvent({ type: "block.delta", blockId: "a", text: null }), /text/);
  assert.deepEqual(validateAgentEvent({ type: "usage", usage: { input: 10, output: NaN, contextMax: -10 } }).usage, { input: 10 });
  assert.equal(receiveAgentEvent("opencode", "thread", { type: "tool.end", callId: "a", ok: "false", output: "SECRET" }), null);
  assert.match(protocolLog().at(-1).issue, /boolean/);
  assert.ok(!JSON.stringify(protocolLog()).includes("SECRET"));
  assert.equal(receiveAgentEvent("opencode", "thread", { type: "turn.end", error: null }).type, "turn.end");
  assert.match(receiveAgentEvent("opencode", "thread", { type: "turn.end", error: null }).error, /invalid completion event/);
});

test.after(() => { eventJournal.close(); rmSync(directory, { recursive: true, force: true }); });
