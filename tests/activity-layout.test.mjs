import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";
import { buildRows, groupStats, summarize } from "../web/src/lib/group.ts";
import { timelineRows, sameTimelineRows } from "../web/src/lib/timeline.ts";

const project = { id: "workspace", name: "VideoPresentationCitropyTest", path: "/example/VideoPresentationCitropyTest", isGit: false, lastOpened: 1 };
const thread = {
  id: "chat", projectId: project.id, provider: "claude", model: "sample", title: "Create a music preview",
  permissionMode: "manual", createdAt: 1, updatedAt: 1, status: "thinking", running: true,
  runStartedAt: Date.now() - 43000,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, contextTokens: 0, contextMax: 200000, turns: 0 },
};
const tool = (id, shape, headline, extra = {}) => ({
  id, kind: "tool", callId: id, name: { command: "Bash", write: "Write", edit: "Edit", read: "Read" }[shape] ?? shape,
  shape, headline, input: {}, status: "ok", startedAt: 1, endedAt: 100, ...extra,
});
const patch = (path) => ({ path, added: 1, removed: 0, hunks: [{ header: "@@ -0,0 +1 @@", oldStart: 0, newStart: 1, lines: [{ type: "add", text: "print('Music preview ready')", newNo: 1 }] }] });
const parts = [
  { id: "reason-1", kind: "reasoning", text: "I will check the audio files and create a short preview.", complete: true },
  tool("write-1", "write", "music_splice.py", { patch: patch("music_splice.py") }),
  tool("read-1", "read", "music.json", { output: "Audio settings loaded." }),
  tool("command-1", "command", "python music_splice.py", { output: "Preview rendered." }),
  { id: "reason-2", kind: "reasoning", text: "The first preview is ready. I will adjust the timing.", complete: true },
  tool("edit-1", "edit", "music_splice.py", { patch: patch("music_splice.py") }),
  tool("command-2", "command", "python music_splice.py", { output: "Timing adjusted." }),
  { id: "reason-3", kind: "reasoning", text: "I will save the keyboard sequence and check the final output.", complete: true },
  tool("write-2", "write", "keystrokes.py", { patch: patch("keystrokes.py") }),
  tool("command-3", "command", "python keystrokes.py", { output: "Sequence checked." }),
];

test("all tool shapes share a group without crossing message content", () => {
  const shapes = ["read", "write", "edit", "command", "search", "web", "computer", "task", "todo", "generic"];
  const tools = shapes.map(shape => tool(shape, shape, `${shape}.txt`));
  assert.deepEqual(buildRows([
    parts[0], ...tools, { id: "blank", kind: "text", text: " \n" }, undefined,
    { id: "notice", kind: "notice", level: "info", text: "Review ready" }, parts[8],
    { id: "answer", kind: "text", text: "Done" },
  ]), [
    { kind: "thoughts", ids: ["reason-1"] }, { kind: "group", ids: shapes },
    { kind: "part", id: "notice" }, { kind: "group", ids: ["write-2"] }, { kind: "part", id: "answer" },
  ]);
  assert.equal(summarize(parts.slice(1, 4)), "Read 1 file, wrote 1 file and ran 1 command");
  assert.deepEqual(groupStats([parts[1], { ...parts[5], status: "denied" }, { ...parts[3], status: "running" }]), {
    added: 2, removed: 0, failed: 1, running: true,
  });
});

test("completed responses fold thoughts, tools and commentary while preserving the answer", () => {
  const content = [
    { id: "progress", kind: "text", text: "I will check the audio files.", complete: true },
    ...parts,
    { id: "answer-1", kind: "text", text: "The music preview is ready.", complete: true },
    { id: "answer-note", kind: "notice", level: "warn", text: "Use headphones for the preview." },
    { id: "answer-2", kind: "text", text: "Run python music_splice.py to play it.", complete: true },
    { id: "warning", kind: "notice", level: "warn", text: "Audio output is unavailable." },
  ];
  const state = {
    threads: { chat: { ...thread, running: false, status: "idle" } },
    order: { chat: ["response"] }, disclosures: {},
    messages: { response: { id: "response", role: "assistant", partIds: content.map(part => part.id) } },
    parts: Object.fromEntries(content.map(part => [part.id, part])),
  };
  const collapsed = timelineRows(state, "chat");
  assert.deepEqual(collapsed.map(row => row.row.kind === "activity" ? "activity" : row.row.id), ["activity", "answer-1", "answer-note", "answer-2", "warning"]);
  assert.ok(collapsed[0].row.ids.includes("progress"));
  assert.ok(collapsed[0].row.ids.includes("reason-1"));
  assert.ok(collapsed[0].row.ids.includes("write-1"));
  assert.equal(collapsed.filter(row => row.first).length, 1);
  assert.deepEqual(collapsed.filter(row => row.separator).map(row => row.row.id), ["answer-1"]);
  for (const status of ["thinking", "working", "awaiting", "stopped", "error"]) {
    const active = { ...state, threads: { chat: { ...thread, status, running: !["stopped", "error"].includes(status) } } };
    assert.equal(timelineRows(active, "chat")[0].row.open, false, status);
  }
  const expanded = timelineRows({ ...state, disclosures: { progress: { activity: true } } }, "chat");
  assert.ok(expanded.length > collapsed.length);
  assert.deepEqual(expanded.filter(row => row.separator).map(row => row.row.id), ["answer-1"]);
  assert.equal(sameTimelineRows(collapsed, collapsed.map(row => ({ ...row, separator: undefined }))), false);
  assert.equal(sameTimelineRows(collapsed, expanded), false);
  assert.equal(sameTimelineRows(collapsed, timelineRows(state, "chat")), true);
  const incomplete = { ...state, parts: { ...state.parts, "answer-2": { ...state.parts["answer-2"], complete: false } } };
  assert.equal(timelineRows(incomplete, "chat")[0].row.open, false);
  const explicit = { ...state, threads: { chat: thread }, disclosures: { progress: { activity: false } } };
  assert.equal(timelineRows(explicit, "chat")[0].row.open, false);
  assert.equal(state.parts["progress"].text, "I will check the audio files.");
});

test("reply fragments share work details without hiding the answer or crossing user messages", () => {
  const content = [tool("early", "command", "check first"), tool("late", "command", "check second"), { id: "answer", kind: "text", text: "Checks complete", complete: true }];
  const state = {
    threads: { chat: { ...thread, running: false, status: "idle" } },
    order: { chat: ["earlier", "later"] }, disclosures: {},
    messages: {
      earlier: { id: "earlier", role: "assistant", partIds: ["early"] },
      later: { id: "later", role: "assistant", partIds: ["late", "answer"] },
    },
    parts: Object.fromEntries(content.map(part => [part.id, part])),
  };
  const rows = timelineRows(state, "chat");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].row.kind, "activity");
  assert.deepEqual(rows[0].row.ids, ["early", "late"]);
  assert.equal(rows[0].row.open, false);
  assert.equal(rows[1].row.id, "answer");
  assert.equal(rows[1].messageId, "later");
  assert.equal(rows[1].separator, true);
  assert.equal(rows.filter(row => row.first).length, 1);
  const open = timelineRows({ ...state, disclosures: { early: { activity: true } } }, "chat");
  assert.deepEqual(open.find(row => row.row?.kind === "group").row.ids, ["early", "late"]);
  const separate = timelineRows({ ...state, order: { chat: ["earlier", "user", "later"] }, messages: { ...state.messages, user: { id: "user", role: "user", partIds: [] } } }, "chat");
  assert.equal(separate.filter(row => row.row?.kind === "activity").length, 2);
});

test("a live turn keeps repeated thoughts and tools in one stable disclosure", () => {
  const content = [
    { id: "progress", kind: "text", text: "Checking the playback timeline.", complete: true },
    ...Array.from({ length: 150 }, (_, index) => [
      { id: `thought-${index}`, kind: "reasoning", text: `Checking frame ${index}.`, complete: true },
      tool(`tool-${index}`, "command", `check frame ${index}`, { status: index === 149 ? "running" : "ok" }),
    ]).flat(),
    { id: "warning", kind: "notice", level: "warn", text: "One check needs attention." },
  ];
  const state = {
    threads: { chat: thread }, order: { chat: ["response"] }, disclosures: {},
    messages: { response: { id: "response", role: "assistant", partIds: content.map(part => part.id) } },
    parts: Object.fromEntries(content.map(part => [part.id, part])),
  };
  const rows = timelineRows(state, "chat");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].row.kind, "activity");
  assert.equal(rows[0].row.active, true);
  assert.equal(rows[0].row.open, false);
  assert.equal(rows[0].row.ids.length, 301);
  assert.equal(rows[1].row.id, "warning");
  const expanded = timelineRows({ ...state, disclosures: { progress: { activity: true } } }, "chat");
  assert.equal(expanded.filter(row => row.row?.kind === "thoughts").length, 150);
  assert.equal(expanded.filter(row => row.row?.kind === "group").length, 150);
  assert.equal(expanded[0].key, rows[0].key);
  const ended = timelineRows({ ...state, threads: { chat: { ...thread, running: false, status: "stopped" } } }, "chat");
  assert.equal(ended[0].row.active, false);
  assert.equal(ended[0].row.open, false);
  assert.equal(sameTimelineRows(rows, ended), false);
});

test("plans, questions and warnings remain visible outside compact activity", () => {
  const content = [
    parts[0], tool("failed", "command", "npm test", { status: "error" }),
    { id: "plan", kind: "todo", items: [{ text: "Fix the failing check", status: "in_progress" }] },
    { id: "question", kind: "question", status: "pending", questions: [] },
    { id: "warning", kind: "notice", level: "error", text: "The check failed." },
  ];
  const state = {
    threads: { chat: thread }, order: { chat: ["response"] }, disclosures: {},
    messages: { response: { id: "response", role: "assistant", partIds: content.map(part => part.id) } },
    parts: Object.fromEntries(content.map(part => [part.id, part])),
  };
  const rows = timelineRows(state, "chat");
  assert.deepEqual(rows.slice(1).map(row => row.row.id), ["plan", "question", "warning"]);
  assert.ok(rows[0].row.ids.includes("failed"));
  assert.equal(groupStats(rows[0].row.ids.map(id => state.parts[id]).filter(part => part.kind === "tool")).failed, 1);
  const finished = { ...state, threads: { chat: { ...thread, running: false, status: "idle" } }, messages: { response: { ...state.messages.response, partIds: ["answer", "reason-1"] } }, parts: { ...state.parts, answer: { id: "answer", kind: "text", text: "Fixed.", complete: true } } };
  assert.ok(timelineRows(finished, "chat").some(row => row.row?.kind === "part" && row.row.id === "answer"));
});

test("consecutive thought fragments share one disclosure without crossing updates or tools", () => {
  assert.deepEqual(buildRows([
    { id: "first-thought", kind: "reasoning", text: "Checking the sequence." },
    { id: "empty-thought", kind: "reasoning", text: "  " },
    { id: "next-thought", kind: "reasoning", text: "Verifying the frames." },
    { id: "update", kind: "text", text: "The render is running." },
    tool("render", "command", "render video"),
    { id: "last-thought", kind: "reasoning", text: "Checking the result." },
  ]), [
    { kind: "thoughts", ids: ["first-thought", "next-thought"] },
    { kind: "part", id: "update" },
    { kind: "group", ids: ["render"] },
    { kind: "thoughts", ids: ["last-thought"] },
  ]);
});

test("steering preserves the running response and plan without presenting old progress as a final answer", () => {
  const content = [
    { id: "update", kind: "text", text: "Starting the final render.", complete: true },
    { id: "plan", kind: "todo", items: [{ text: "Render and verify", status: "in_progress" }] },
    tool("render", "command", "sleep 240; check render", { status: "running" }),
    { id: "answered", kind: "question", status: "answered", questions: [] },
  ];
  const state = {
    threads: { chat: { ...thread, runStartedAt: 100 } }, order: { chat: ["response", "follow-up"] }, disclosures: {},
    messages: {
      response: { id: "response", role: "assistant", ts: 110, partIds: content.map(part => part.id) },
      "follow-up": { id: "follow-up", role: "user", ts: 200, partIds: [] },
    },
    parts: Object.fromEntries(content.map(part => [part.id, part])),
  };
  const rows = timelineRows(state, "chat");
  assert.deepEqual(rows.map(row => row.row?.kind), ["activity", "part", undefined]);
  assert.equal(rows[0].row.active, true);
  assert.equal(rows[0].row.previewId, "update");
  assert.equal(rows[1].row.id, "plan");
  assert.ok(rows[0].row.ids.includes("answered"));
  assert.equal(rows.some(row => row.separator), false);
  const continuation = { ...state, order: { chat: [...state.order.chat, "continuation"] }, messages: { ...state.messages, continuation: { id: "continuation", role: "assistant", ts: 220, partIds: ["next-tool"] } }, parts: { ...state.parts, "next-tool": tool("next-tool", "read", "result.png") } };
  const continued = timelineRows(continuation, "chat");
  assert.equal(continued.filter(row => row.row?.kind === "activity" && row.row.active).length, 1);
  assert.equal(continued.find(row => row.row?.kind === "activity" && row.row.active).messageId, "continuation");
  assert.ok(continued.some(row => row.row?.kind === "part" && row.row.id === "plan"));
  const nextRun = timelineRows({ ...state, threads: { chat: { ...thread, runStartedAt: 300 } } }, "chat");
  assert.equal(nextRun[0].row.active, false);
  assert.equal(nextRun.some(row => row.row?.kind === "part" && row.row.id === "update"), false);
});

test("compact activity layout", { timeout: 60000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-activity-"));
  let server;
  let browser;
  t.after(async () => {
    await browser?.close();
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  });
  server = await createServer({
    configFile: false, cacheDir: join(directory, "node_modules", ".vite"),
    root: fileURLToPath(new URL("..", import.meta.url)), plugins: [react()], logLevel: "error",
    server: { host: "127.0.0.1", port: 0, watch: null },
  });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  async function fixture(t, preferences = {}) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors = [];
    let connection;
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
    await page.addInitScript(preferences => {
      for (const [key, value] of Object.entries({ project: "workspace", thread: "chat", inspector: "0", theme: "dark", uiScale: "120", panelWidths: '{"sidebar":216}', ...preferences })) localStorage.setItem(`citropy.${key}`, value);
    }, preferences);
    await page.routeWebSocket("**/socket", socket => {
      connection = socket;
      socket.onMessage(raw => {
        const event = JSON.parse(raw);
        if (event.t === "thread.load") socket.send(JSON.stringify({ t: "thread.messages", threadId: "chat", messages: [{ id: "response", role: "assistant", ts: 1, parts }] }));
        if (event.t === "github.request") socket.send(JSON.stringify({ t: "github.result", requestId: event.requestId, result: { installed: false, repositories: [] } }));
      });
      socket.send(JSON.stringify({ t: "hello", snapshot: { projects: [project], threads: [thread], providers: [{ id: "claude", label: "Claude Code", available: true, enabled: true, models: [{ id: "sample", label: "Claude Opus 5" }] }], permissions: [], home: "/example" } }));
    });
    await page.goto(server.resolvedUrls.local[0]);
    await page.locator(".working").waitFor();
    await page.locator(".activity-head").waitFor();
    return { page, emit: event => connection.send(JSON.stringify(event)) };
  }

  await t.test("steered work keeps readable progress and keyboard-accessible thought groups", async (t) => {
    const { page, emit } = await fixture(t, { sidebar: "0" });
    const startedAt = thread.runStartedAt;
    emit({ t: "thread.messages", threadId: "chat", messages: [
      { id: "render-response", role: "assistant", ts: startedAt + 100, parts: [
        { id: "render-thought-1", kind: "reasoning", text: "Checking **the frame order**.", complete: true },
        { id: "render-thought-2", kind: "reasoning", text: "Verifying the audio timing.", complete: true },
        { id: "render-update", kind: "text", text: "The final render is running. I will check the audio when it finishes.", complete: true },
        tool("render-command", "command", "sleep 240; check render", { status: "running" }),
        { id: "render-plan", kind: "todo", items: [{ text: "Prepare the video", status: "completed" }, { text: "Render and verify the audio", status: "in_progress" }] },
      ] },
      { id: "render-follow-up", role: "user", ts: startedAt + 200, parts: [{ id: "follow-up-text", kind: "text", text: "Is it ready?" }] },
    ] });
    await page.getByRole("note", { name: "Latest update", exact: true }).getByText("The final render is running. I will check the audio when it finishes.", { exact: true }).waitFor();
    assert.equal(await page.locator(".working").count(), 1);
    assert.equal(await page.locator(".turn-agent .turn-heading").count(), 1);
    assert.equal(await page.locator('[data-part-id="render-update"]').count(), 0);
    assert.equal(await page.locator(".activity-preview").innerText(), "Running command");
    assert.equal(await page.locator(".reason-text").count(), 0);
    const plan = page.getByRole("region", { name: "Plan", exact: true });
    await plan.locator(".todo-current").getByText("Render and verify the audio", { exact: true }).waitFor();
    assert.equal(await plan.getByRole("listitem").count(), 0);
    await page.getByRole("button", { name: "Work details", exact: true }).click();
    const thoughts = page.getByRole("button", { name: "Thoughts (2)", exact: true });
    await thoughts.waitFor();
    assert.equal(await thoughts.getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator(".reason-text").count(), 0);
    await thoughts.focus();
    await page.keyboard.press("Enter");
    await page.locator('[data-part-id="render-thought-1"] strong').getByText("the frame order", { exact: true }).waitFor();
    assert.equal(await page.locator(".reason-text").count(), 2);
    emit({ t: "part.append", threadId: "chat", messageId: "render-response", partId: "render-thought-2", text: " Checking the final mix." });
    await page.locator('[data-part-id="render-thought-2"]').getByText(/Checking the final mix/).waitFor();
    assert.equal(await thoughts.getAttribute("aria-expanded"), "true");
    assert.equal(await page.locator(".reason-text").evaluateAll(nodes => nodes.some(node => node.getAnimations().length)), false);
    await thoughts.press("Space");
    await page.locator(".reason-text").first().waitFor({ state: "detached" });
    assert.equal(await thoughts.evaluate(node => node === document.activeElement), true);
    await page.setViewportSize({ width: 660, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  });

  await t.test("thoughts render Markdown during streaming and when reopened from work details", async (t) => {
    const start = "## Check the encoder\n\nUse **one pass** for the `digest` and keep the *frame order*.\n\n- Read the metadata\n- Verify the final block\n\n```js\nconst digest = calculateDigest(\"" + "sample-".repeat(30);
    const end = "\");\n```\n\n| Case | Result |\n| --- | --- |\n| Short file | Ready |\n\n[Reference](https://example.com/encoder) and [Blocked](javascript:alert%281%29).\n\n<span onclick=\"alert(1)\">Raw HTML</span>";
    for (const streaming of ["1", "0"]) {
      const { page, emit } = await fixture(t, { textStreaming: streaming, sidebar: "0" });
      emit({ t: "thread.messages", threadId: "chat", messages: [{ id: "markdown-response", role: "assistant", ts: 1, parts: [{ id: "markdown-thought", kind: "reasoning", text: start, complete: false }] }] });
      await page.waitForFunction(async () => (await import("/web/src/lib/store.ts")).useApp.getState().parts["markdown-thought"]?.text.startsWith("## Check"));
      await page.getByRole("button", { name: "Work details", exact: true }).click();
      await page.getByRole("button", { name: "Thoughts", exact: true }).click();
      const thought = page.locator(".reason-text");
      if (streaming === "1") {
        await thought.getByRole("heading", { name: "Check the encoder", exact: true }).waitFor();
        assert.equal(await thought.locator("strong").textContent(), "one pass");
        await thought.locator("pre code").getByText(/sample-$/).waitFor();
      } else {
        assert.equal(await thought.count(), 0);
      }
      emit({ t: "part.append", threadId: "chat", messageId: "markdown-response", partId: "markdown-thought", text: end });
      if (streaming === "0") emit({ t: "part.patch", threadId: "chat", messageId: "markdown-response", partId: "markdown-thought", patch: { complete: true } });
      await thought.locator("table").waitFor();
      assert.equal(await thought.locator("h2").textContent(), "Check the encoder");
      assert.equal(await thought.locator("strong").textContent(), "one pass");
      assert.equal(await thought.locator("em").textContent(), "frame order");
      assert.equal(await thought.locator("p > code").textContent(), "digest");
      assert.deepEqual(await thought.locator("li").allTextContents(), ["Read the metadata", "Verify the final block"]);
      assert.match(await thought.locator("pre code").textContent(), /const digest = calculateDigest\("sample-.*"\);/);
      assert.equal(await thought.getByRole("link", { name: "Reference", exact: true }).getAttribute("href"), "https://example.com/encoder");
      assert.equal(await thought.getByRole("link", { name: "Blocked", exact: true }).getAttribute("href"), "#");
      assert.equal(await thought.locator("[onclick]").count(), 0);
      assert.ok((await thought.textContent()).includes('<span onclick="alert(1)">Raw HTML</span>'));
      for (const [width, theme] of [[1440, "dark"], [600, "light"], [420, "dark"]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(async theme => (await import("/web/src/lib/store.ts")).setTheme(theme), theme);
        await thought.locator(`pre.citropy-${theme} code`).getByText(/const digest/).waitFor();
        await page.waitForFunction(() => !document.querySelector(".reason-text").getAnimations().some(animation => animation.playState === "running"));
        assert.equal(await thought.evaluate(node => node.scrollWidth > node.clientWidth + 1), false);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        const code = await thought.locator("pre").evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth }));
        assert.ok(code.scroll > code.width, JSON.stringify(code));
        await thought.screenshot({ path: `/tmp/citropy-thought-markdown-${streaming}-${width}.png`, animations: "disabled" });
      }
      emit({ t: "part.patch", threadId: "chat", messageId: "markdown-response", partId: "markdown-thought", patch: { complete: true } });
      emit({ t: "part.add", threadId: "chat", messageId: "markdown-response", part: { id: "markdown-answer", kind: "text", text: "The encoder is ready.", complete: true } });
      emit({ t: "thread.upsert", thread: { ...thread, status: "idle", running: false } });
      await page.getByRole("button", { name: "Work details", exact: true }).click();
      await thought.waitFor({ state: "detached" });
      await page.getByRole("button", { name: /^Work details/ }).click();
      await thought.locator("table").waitFor();
      assert.equal(await thought.locator("strong").textContent(), "one pass");
      assert.equal(await thought.locator("[data-reveal-hidden]").count(), 0);
      assert.equal(await page.locator('[data-part-id="markdown-answer"]').textContent(), "The encoder is ready.\n");
    }
  });

  await t.test("thought text stays readable through streaming and tool use until the response finishes", async (t) => {
    for (const streaming of ["1", "0"]) {
      const { page, emit } = await fixture(t, { textStreaming: streaming });
      const text = "I will inspect the audio settings before changing the preview.\n\nThe timing needs to match the existing sequence. I will read the configuration, check the track lengths, and then adjust the transition between sections. Once that is ready, I can render a short preview and compare it with the original.";
      emit({ t: "thread.messages", threadId: "chat", messages: [{ id: "thinking-response", role: "assistant", ts: 1, parts: [{ id: "live-thought", kind: "reasoning", text: "", complete: false }] }] });
      await page.locator(".reason-text").first().waitFor({ state: "detached" });
      emit({ t: "part.append", threadId: "chat", messageId: "thinking-response", partId: "live-thought", text });
      await page.getByRole("button", { name: "Work details", exact: true }).click();
      await page.getByRole("button", { name: "Thoughts", exact: true }).click();
      if (streaming === "1") {
        await page.locator(".reason-text p").nth(1).getByText(text.split("\n\n")[1], { exact: true }).waitFor();
        assert.deepEqual(await page.locator(".reason-text p").allTextContents(), text.split("\n\n"));
        assert.equal(await page.locator(".reason-head").count(), 0);
        emit({ t: "part.append", threadId: "chat", messageId: "thinking-response", partId: "live-thought", text: " I will start with music.json." });
        await page.locator(".reason-text").getByText(/I will start with music.json\.$/).waitFor();
      } else {
        await page.waitForFunction(async () => (await import("/web/src/lib/store.ts")).useApp.getState().parts["live-thought"]?.text.length > 260);
        assert.equal(await page.locator(".reason-text").count(), 0);
      }
      emit({ t: "part.patch", threadId: "chat", messageId: "thinking-response", partId: "live-thought", patch: { complete: true } });
      emit({ t: "part.add", threadId: "chat", messageId: "thinking-response", part: tool("live-read", "read", "music.json", { status: "running" }) });
      await page.locator(".group-label").getByText("Read 1 file", { exact: true }).waitFor();
      await page.locator(".reason-text").getByText(/^I will inspect the audio settings/).waitFor();
      assert.equal(await page.locator(".reason-head").count(), 0);
      emit({ t: "part.patch", threadId: "chat", messageId: "thinking-response", partId: "live-read", patch: { status: "ok" } });
      emit({ t: "part.add", threadId: "chat", messageId: "thinking-response", part: { id: "next-thought", kind: "reasoning", text: "The settings are ready. I can now render the preview.", complete: true } });
      await page.locator('.reasoning-head[aria-controls="thoughts-next-thought"]').click();
      await page.locator(".reason-text").getByText("The settings are ready. I can now render the preview.", { exact: true }).waitFor();
      assert.equal(await page.locator(".reason-text").count(), 2);
      emit({ t: "part.add", threadId: "chat", messageId: "thinking-response", part: { id: "thinking-answer", kind: "text", text: "The preview is ready.", complete: true } });
      emit({ t: "thread.upsert", thread: { ...thread, status: "idle", running: false } });
      await page.getByRole("button", { name: "Work details", exact: true }).click();
      await page.locator(".reason-text").first().waitFor({ state: "detached" });
      await page.locator('[data-part-id="thinking-answer"]').getByText("The preview is ready.", { exact: true }).waitFor();
      await page.getByRole("button", { name: /^Work details/ }).click();
      await page.locator(".reason-text").getByText("The settings are ready. I can now render the preview.", { exact: true }).waitFor();
      assert.equal(await page.locator(".reason-text").count(), 2);
    }
  });

  await t.test("writes and edits expand inside their group and streaming keeps disclosures", async (t) => {
    const { page, emit } = await fixture(t);
    await page.getByRole("button", { name: "Work details", exact: true }).click();
    assert.equal(await page.locator(".group").count(), 3);
    assert.equal(await page.locator(".tool").count(), 0);
    const first = page.locator(".group").first();
    assert.equal(await first.locator(".group-label").innerText(), "Read 1 file, wrote 1 file and ran 1 command");
    await first.locator(".group-head").click();
    await first.locator(".tool").last().waitFor();
    assert.equal(await first.locator(".tool").count(), 3);
    const write = first.locator('.tool[data-shape="write"]');
    assert.equal(await write.locator(".tool-head").getAttribute("aria-expanded"), "false");
    assert.equal(await write.locator(".diff").count(), 0);
    await write.locator(".tool-head").click();
    await write.locator(".diff").getByText("print('Music preview ready')", { exact: true }).waitFor();
    await first.locator(".group-head").click();
    await first.locator(".tool").first().waitFor({ state: "detached" });
    await first.locator(".group-head").click();
    await write.locator(".diff").waitFor();
    const last = page.locator(".group").last();
    await last.locator(".group-head").click();
    emit({ t: "part.add", threadId: "chat", messageId: "response", part: tool("write-3", "write", "final.py", { status: "running" }) });
    await last.locator(".tool-headline").getByText("final.py", { exact: true }).waitFor();
    assert.equal(await page.locator(".group").count(), 3);
    assert.equal(await last.locator(".group-head").getAttribute("aria-expanded"), "true");
    assert.equal(await write.locator(".tool-head").getAttribute("aria-expanded"), "true");
    emit({ t: "part.patch", threadId: "chat", messageId: "response", partId: "write-3", patch: { status: "ok", patch: patch("final.py") } });
    await last.locator(".group-head .diff-plus").getByText("+2", { exact: true }).waitFor();
    assert.equal(await last.locator('.tool[data-shape="write"]').last().locator(".tool-head").getAttribute("aria-expanded"), "false");
    await page.screenshot({ path: "/tmp/citropy-activity-expanded.png", animations: "disabled" });
  });

  await t.test("thought disclosures and collapsed tools keep compact spacing at desktop and narrow widths", async (t) => {
    const { page } = await fixture(t);
    await page.getByRole("button", { name: "Work details", exact: true }).click();
    for (const width of [1440, 960]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(200);
      await page.screenshot({ path: `/tmp/citropy-activity-${width}.png`, animations: "disabled" });
      assert.equal(await page.locator(".reason-text").count(), 0);
      assert.equal(await page.locator(".reasoning-head").count(), 3);
      const rows = await page.locator(".reasoning, .group").evaluateAll(nodes => nodes.map(node => {
        const { y, height } = node.getBoundingClientRect();
        return { y, height };
      }));
      for (let index = 1; index < rows.length; index++) {
        const gap = rows[index].y - rows[index - 1].y - rows[index - 1].height;
        assert.ok(gap >= 0 && gap <= 8, JSON.stringify({ width, index, gap }));
      }
    }
  });

  await t.test("long workspace names truncate inside the topbar as the window resizes", async (t) => {
    const { page, emit } = await fixture(t);
    const name = `${project.name}-with-a-long-workspace-name`.repeat(3);
    emit({ t: "project.upsert", project: { ...project, name } });
    const selector = page.getByRole("button", { name: `Choose workspace, ${name}`, exact: true });
    await selector.getByText(name, { exact: true }).waitFor();
    for (const width of [1440, 960, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const topbar = await page.locator(".topbar").boundingBox();
      const button = await selector.boundingBox();
      assert.ok(button.x >= topbar.x && button.x + button.width <= topbar.x + topbar.width, JSON.stringify({ width, topbar, button }));
      const label = await selector.locator(".truncate > span:not([aria-hidden])").evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth, overflow: getComputedStyle(element).textOverflow }));
      assert.ok(label.scroll > label.client, JSON.stringify({ width, label }));
      assert.equal(label.overflow, "ellipsis");
      const chevron = await selector.locator("svg").last().boundingBox();
      assert.ok(chevron.x + chevron.width < button.x + button.width);
      await selector.click();
      await page.getByRole("menuitem", { name: new RegExp(`^${name} `) }).waitFor();
      await page.keyboard.press("Escape");
    }
  });

  await t.test("a live response stays folded while streaming and keeps its answer and expandable history", async (t) => {
    const { page, emit } = await fixture(t);
    const details = page.getByRole("button", { name: /^Work details/ });
    await details.waitFor();
    assert.equal(await details.getAttribute("aria-expanded"), "false");
    emit({ t: "part.add", threadId: "chat", messageId: "response", part: { id: "answer", kind: "text", text: "The music preview is ready. Run python music_splice.py to play it.", complete: false } });
    await page.locator('[data-part-id="answer"]').waitFor();
    assert.equal(await details.getAttribute("aria-expanded"), "false");
    emit({ t: "part.patch", threadId: "chat", messageId: "response", partId: "answer", patch: { complete: true } });
    assert.equal(await details.getAttribute("aria-expanded"), "false");
    emit({ t: "thread.upsert", thread: { ...thread, status: "idle", running: false } });
    await page.locator(".reason-text").first().waitFor({ state: "detached" });
    assert.equal(await details.getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator(".group-head").count(), 0);
    assert.equal(await page.locator(".turn-heading").count(), 1);
    for (const width of [1440, 960]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: `/tmp/citropy-work-fold-${width}.png`, animations: "disabled" });
      assert.equal(await page.locator('[data-part-id="answer"]').isVisible(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const spacing = await page.evaluate(() => {
        const summary = document.querySelector(".activity-head").getBoundingClientRect();
        const answer = document.querySelector(".agent-card").getBoundingClientRect();
        return { gap: answer.top - summary.bottom };
      });
      assert.ok(spacing.gap >= 20 && spacing.gap <= 32, JSON.stringify({ width, ...spacing }));
      assert.equal(await details.locator("svg.activity-icon").count(), 1);
    }
    await details.click();
    await page.getByRole("button", { name: "Thoughts", exact: true }).first().click();
    await page.locator(".reason-text").getByText(parts[0].text, { exact: true }).waitFor();
    await page.locator(".group-head").first().click();
    await page.locator('.tool[data-shape="write"] .tool-head').first().click();
    await page.locator(".diff").getByText("print('Music preview ready')", { exact: true }).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll(".collapsible")].every(element => Math.abs(element.offsetHeight - element.firstElementChild.scrollHeight) < 2));
    await page.screenshot({ path: "/tmp/citropy-work-fold-expanded.png", animations: "disabled" });
    assert.equal(await page.locator(".work-separator").count(), 1);
    assert.equal(await page.locator(".work-separator + .agent-card [data-part-id=answer]").count(), 1);
    await details.click();
    assert.equal(await page.locator(".reason-text").count(), 0);
    await page.evaluate(async () => (await import("/web/src/lib/store.ts")).useApp.setState({ searchMessageId: "response" }));
    await page.locator(".reason-text").first().waitFor();
    await page.locator(".diff").waitFor();
  });

  await t.test("plans recover provider text, wrap long steps, and update without empty cards", async (t) => {
    const { page, emit } = await fixture(t);
    const items = [
      { content: "Inspect stopped container configuration", status: "in_progress", priority: "high" },
      { content: "Start the service and verify its public address before sharing the connection details with the team", status: "pending", priority: "high" },
      { content: "Check /workspace/" + "long-directory/".repeat(16) + "settings.json", status: "completed" },
      { content: "Replace the existing configuration", status: "cancelled" },
    ];
    emit({ t: "thread.messages", threadId: "chat", messages: [{ id: "plan-response", role: "assistant", ts: 1, parts: [{ id: "plan", kind: "todo", items }] }] });
    const plan = page.getByRole("region", { name: "Plan", exact: true });
    await plan.locator(".todo-current").getByText(items[0].content, { exact: true }).waitFor();
    assert.equal(await plan.getByRole("listitem").count(), 0);
    await plan.getByRole("button", { name: /^Plan/ }).click();
    assert.equal(await plan.getByRole("listitem").count(), 4);
    await plan.getByRole("img", { name: "In progress", exact: true }).waitFor();
    await plan.getByRole("img", { name: "Cancelled", exact: true }).waitFor();
    assert.equal(await plan.locator("animateTransform").count(), 0);
    for (const width of [1440, 700]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 700) await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
      assert.ok(await plan.evaluate(element => element.scrollWidth <= element.clientWidth));
      const bounds = await plan.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
      await page.screenshot({ path: `/tmp/citropy-plan-${width}.png`, animations: "disabled" });
    }
    emit({ t: "part.patch", threadId: "chat", messageId: "plan-response", partId: "plan", patch: { items: items.map(item => ({ text: item.content, status: "completed" })) } });
    await plan.getByText("4/4", { exact: true }).waitFor();
    emit({ t: "part.add", threadId: "chat", messageId: "plan-response", part: { id: "plan-answer", kind: "text", text: "The plan is complete.", complete: true } });
    emit({ t: "thread.upsert", thread: { ...thread, running: false, status: "idle" } });
    await plan.waitFor({ state: "detached" });
    await page.getByRole("button", { name: /^Work details/ }).click();
    await plan.getByText("4/4", { exact: true }).waitFor();
    emit({ t: "part.patch", threadId: "chat", messageId: "plan-response", partId: "plan", patch: { items: [] } });
    await plan.waitFor({ state: "detached" });
    assert.equal(await page.locator(".activity-head").count(), 0);
    assert.ok(await page.getByText("The plan is complete.", { exact: true }).isVisible());
  });

  await t.test("split replies keep every command inside one work details section", async (t) => {
    const { page, emit } = await fixture(t);
    emit({ t: "thread.messages", threadId: "chat", messages: [
      { id: "first-fragment", role: "assistant", ts: 1, parts: [tool("earlier-command", "command", "check environment")] },
      { id: "last-fragment", role: "assistant", ts: 2, parts: [tool("later-command", "command", "check result"), { id: "fragment-answer", kind: "text", text: "Both checks finished successfully.", complete: true }] },
    ] });
    emit({ t: "thread.upsert", thread: { ...thread, running: false, status: "idle" } });
    const details = page.getByRole("button", { name: /^Work details/ });
    await page.locator('[data-part-id="fragment-answer"]').waitFor();
    assert.equal(await details.count(), 1);
    assert.equal(await details.getAttribute("aria-expanded"), "false");
    assert.match(await details.innerText(), /2 tools/);
    assert.equal(await page.locator(".group-head").count(), 0);
    assert.equal(await page.locator(".working").count(), 0);
    assert.equal(await page.locator(".turn-heading").count(), 1);
    for (const width of [1440, 700]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 700) await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
      await page.screenshot({ path: `/tmp/citropy-reply-fragments-${width}.png`, animations: "disabled" });
    }
    await page.evaluate(async () => (await import("/web/src/lib/store.ts")).useApp.setState({ searchMessageId: "last-fragment" }));
    await page.getByRole("button", { name: /^Ran 2 commands/ }).click();
    await page.getByText("check environment", { exact: true }).waitFor();
    await page.getByText("check result", { exact: true }).waitFor();
    await details.click();
    assert.equal(await page.locator(".group-head").count(), 0);
    assert.ok(await page.locator('[data-part-id="fragment-answer"]').isVisible());
  });

  await t.test("long work histories stay windowed when opened and settle on the visible final answer", async (t) => {
    const { page, emit } = await fixture(t);
    const content = Array.from({ length: 120 }, (_, index) => [
      { id: `long-thought-${index}`, kind: "reasoning", text: `Check the timing for section ${index}.`, complete: true },
      tool(`long-tool-${index}`, "read", `section-${index}.txt`),
    ]).flat();
    emit({ t: "thread.messages", threadId: "chat", messages: [{ id: "long-response", role: "assistant", ts: 1, parts: content }] });
    await page.locator(".activity-head .reason-count").getByText("120 tools", { exact: true }).waitFor();
    assert.equal(await page.locator(".timeline-row").count(), 1);
    assert.equal(await page.locator(".reason-text").count(), 0);
    emit({ t: "part.add", threadId: "chat", messageId: "long-response", part: { id: "long-answer", kind: "text", text: "All 120 sections are ready.", complete: true } });
    emit({ t: "thread.upsert", thread: { ...thread, running: false, status: "idle" } });
    await page.locator('.activity-head[aria-expanded="false"]').waitFor();
    await page.locator('[data-part-id="long-answer"]').waitFor();
    assert.equal(await page.locator(".timeline-row").count(), 2);
    const details = page.getByRole("button", { name: /^Work details/ });
    for (let index = 0; index < 4; index++) {
      await details.click();
      await page.locator(".reasoning-head").first().waitFor();
      assert.equal(await page.locator(".reason-text").count(), 0);
      assert.ok(await page.locator(".timeline-row").count() < 40);
      assert.equal(await details.isVisible(), true, JSON.stringify(await page.evaluate(() => ({
        scrollTop: document.querySelector(".canvas").scrollTop,
        height: document.querySelector(".canvas").scrollHeight,
        rows: [...document.querySelectorAll(".timeline-row")].map(element => Number(element.dataset.index)),
      }))));
      await details.press("Space");
      await page.locator('[data-part-id="long-answer"]').waitFor();
      assert.equal(await page.locator(".timeline-row").count(), 2);
      assert.equal(await details.evaluate(element => element === document.activeElement), true);
    }
  });
});
