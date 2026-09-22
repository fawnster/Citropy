import assert from "node:assert/strict";
import { test } from "node:test";
import { createTimelineSelector, timelineRows } from "../web/src/lib/timeline.ts";

function fixture() {
  return {
    threads: { chat: { running: true, status: "working", runStartedAt: 1 } },
    order: { chat: ["user", "response"] },
    messages: {
      user: { id: "user", role: "user", ts: 1, partIds: ["prompt"] },
      response: { id: "response", role: "assistant", ts: 2, partIds: ["progress", "tool"] },
    },
    parts: {
      prompt: { id: "prompt", kind: "text", text: "Check the files", complete: true },
      progress: { id: "progress", kind: "text", text: "Checking", complete: true },
      tool: { id: "tool", kind: "tool", name: "Read", status: "running" },
    },
    disclosures: {},
  };
}

test("timeline selection skips history scans for repeated snapshots and unrelated changes", () => {
  let reads = 0;
  const state = fixture();
  state.parts = new Proxy(state.parts, {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const select = createTimelineSelector("chat");
  const rows = select(state);
  assert.ok(reads > 0);
  reads = 0;
  for (const update of [
    state,
    { ...state, sidebarOpen: true },
    { ...state, git: { workspace: { branch: "main" } } },
    { ...state, notifications: [{ id: "notification" }] },
    { ...state, threads: { chat: { ...state.threads.chat, usage: { output: 500 }, activeTool: "Read next file", updatedAt: 4 } } },
    { ...state, order: { ...state.order, other: ["unloaded"] } },
  ]) assert.strictEqual(select(update), rows);
  assert.equal(reads, 0);
});

test("timeline selection tracks immutable layout changes while retaining unchanged rows", () => {
  const select = createTimelineSelector("chat");
  let state = fixture();
  let rows = select(state);
  state = { ...state, parts: { ...state.parts, progress: { ...state.parts.progress, text: "Checking more files" } } };
  assert.strictEqual(select(state), rows);
  state = { ...state, parts: { ...state.parts, tool: { ...state.parts.tool, status: "ok" } } };
  assert.strictEqual(select(state), rows);

  for (const change of [
    state => ({ ...state, disclosures: { progress: { activity: true } } }),
    state => ({ ...state, parts: { ...state.parts, tool: { ...state.parts.tool, images: [{ id: "preview", mime: "image/png" }] } } }),
    state => ({ ...state, messages: { ...state.messages, response: { ...state.messages.response, partIds: ["progress", "tool", "answer"] } }, parts: { ...state.parts, answer: { id: "answer", kind: "text", text: "Done", complete: true } } }),
    state => ({ ...state, threads: { chat: { ...state.threads.chat, running: false, status: "idle" } } }),
    state => ({ ...state, order: { chat: ["response", "user"] } }),
    state => ({ ...state, messages: { ...state.messages, user: { ...state.messages.user, role: "assistant" } } }),
    state => ({ ...state, parts: { ...state.parts, prompt: { ...state.parts.prompt, text: "" } } }),
    state => ({ ...state, messages: { user: state.messages.user } }),
  ]) {
    state = change(state);
    const next = select(state);
    assert.notStrictEqual(next, rows);
    assert.deepEqual(next, timelineRows(state, "chat"));
    rows = next;
  }
});

test("timeline selection notices thread creation, removal and run boundaries", () => {
  const select = createTimelineSelector("chat");
  const state = fixture();
  const changes = [
    { ...state, threads: {} },
    state,
    { ...state, threads: {} },
    { ...state, threads: { chat: { status: "idle", compacting: true } } },
    { ...state, order: { chat: ["response", "user"] } },
    { ...state, order: { chat: ["response", "user"] }, threads: { chat: { ...state.threads.chat, runStartedAt: 5 } } },
    { ...state, threads: { chat: { status: "queued" } } },
    { ...state, threads: { chat: { status: "idle" } } },
    { ...state, order: {} },
  ];
  for (const changed of changes) assert.deepEqual(select(changed), timelineRows(changed, "chat"));
  const empty = createTimelineSelector(null);
  assert.strictEqual(empty(state), empty(changes[0]));
  assert.deepEqual(empty(state), []);
});

test("reply grouping ignores absent, blank and notice tails without reading user content", () => {
  const state = fixture();
  state.parts.prompt = { ...state.parts.prompt, get text() { throw new Error("User text is not needed for timeline layout"); } };
  state.parts.blank = { id: "blank", kind: "reasoning", text: " \n" };
  state.parts.notice = { id: "notice", kind: "notice", level: "warn", text: "Notice" };
  state.parts.answer = { id: "answer", kind: "text", text: "Done", complete: true };
  state.messages.response.partIds.push("absent", "blank", "notice");
  state.messages.continuation = { id: "continuation", role: "assistant", ts: 3, partIds: ["answer"] };
  state.order.chat.push("continuation");
  const rows = timelineRows(state, "chat");
  assert.deepEqual(rows.map(row => row.key), ["user", "activity-response", "notice", "answer"]);
  assert.deepEqual(rows[1].row.messageIds, ["response", "continuation"]);
  assert.equal(rows.at(-1).messageId, "continuation");
});

test("final answer boundaries distinguish later work, notices and unfinished thought tails", () => {
  const answer = { id: "answer", kind: "text", text: "Done", complete: true };
  const warning = { id: "warning", kind: "notice", level: "warn", text: "Check this" };
  const thought = { id: "thought", kind: "reasoning", text: "One more thought", complete: true };
  const laterTool = { id: "later-tool", kind: "tool", name: "Read", status: "ok" };
  for (const { tail, running, final } of [
    { tail: [answer], running: true, final: true },
    { tail: [answer, warning], running: true, final: true },
    { tail: [answer, thought], running: true, final: false },
    { tail: [answer, thought], running: false, final: true },
    { tail: [answer, laterTool], running: false, final: false },
    { tail: [warning], running: false, final: false },
  ]) {
    const state = fixture();
    state.threads.chat = { ...state.threads.chat, running, status: running ? "working" : "idle" };
    for (const part of tail) {
      state.parts[part.id] = part;
      state.messages.response.partIds.push(part.id);
    }
    const rows = timelineRows(state, "chat");
    assert.deepEqual(rows.filter(row => row.separator).map(row => row.key), final ? ["answer"] : []);
    const activity = rows.find(row => row.row?.kind === "activity").row;
    assert.equal(activity.ids.includes("answer"), tail.includes(answer) && !final);
    if (tail.includes(warning)) assert.ok(rows.some(row => row.key === "warning"));
    assert.equal(activity.previewId, final ? undefined : tail.includes(answer) ? "answer" : "progress");
  }
});
