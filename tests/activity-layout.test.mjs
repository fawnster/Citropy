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
    { kind: "part", id: "reason-1" }, { kind: "group", ids: shapes },
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
    assert.equal(timelineRows(active, "chat")[0].row.open, true, status);
  }
  const expanded = timelineRows({ ...state, disclosures: { progress: { activity: true } } }, "chat");
  assert.ok(expanded.length > collapsed.length);
  assert.deepEqual(expanded.filter(row => row.separator).map(row => row.row.id), ["answer-1"]);
  assert.equal(sameTimelineRows(collapsed, collapsed.map(row => ({ ...row, separator: undefined }))), false);
  assert.equal(sameTimelineRows(collapsed, expanded), false);
  assert.equal(sameTimelineRows(collapsed, timelineRows(state, "chat")), true);
  const incomplete = { ...state, parts: { ...state.parts, "answer-2": { ...state.parts["answer-2"], complete: false } } };
  assert.equal(timelineRows(incomplete, "chat")[0].row.open, true);
  const explicit = { ...state, threads: { chat: thread }, disclosures: { progress: { activity: false } } };
  assert.equal(timelineRows(explicit, "chat")[0].row.open, false);
  assert.equal(state.parts["progress"].text, "I will check the audio files.");
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
    await page.locator(".reason-text").first().waitFor();
    return { page, emit: event => connection.send(JSON.stringify(event)) };
  }

  await t.test("thought text stays readable through streaming and tool use until the response finishes", async (t) => {
    for (const streaming of ["1", "0"]) {
      const { page, emit } = await fixture(t, { textStreaming: streaming });
      const text = "I will inspect the audio settings before changing the preview.\n\nThe timing needs to match the existing sequence. I will read the configuration, check the track lengths, and then adjust the transition between sections. Once that is ready, I can render a short preview and compare it with the original.";
      emit({ t: "thread.messages", threadId: "chat", messages: [{ id: "thinking-response", role: "assistant", ts: 1, parts: [{ id: "live-thought", kind: "reasoning", text: "", complete: false }] }] });
      await page.locator(".reason-text").first().waitFor({ state: "detached" });
      emit({ t: "part.append", threadId: "chat", messageId: "thinking-response", partId: "live-thought", text });
      if (streaming === "1") {
        await page.locator(".reason-text").getByText(text, { exact: true }).waitFor();
        assert.equal(await page.locator(".reason-text").textContent(), text);
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
      await page.locator(".reason-text").getByText("The settings are ready. I can now render the preview.", { exact: true }).waitFor();
      assert.equal(await page.locator(".reason-text").count(), 2);
      emit({ t: "part.add", threadId: "chat", messageId: "thinking-response", part: { id: "thinking-answer", kind: "text", text: "The preview is ready.", complete: true } });
      emit({ t: "thread.upsert", thread: { ...thread, status: "idle", running: false } });
      await page.locator(".reason-text").first().waitFor({ state: "detached" });
      await page.locator('[data-part-id="thinking-answer"]').getByText("The preview is ready.", { exact: true }).waitFor();
      await page.getByRole("button", { name: /^Work details/ }).click();
      await page.locator(".reason-text").getByText("The settings are ready. I can now render the preview.", { exact: true }).waitFor();
      assert.equal(await page.locator(".reason-text").count(), 2);
    }
  });

  await t.test("writes and edits expand inside their group and streaming keeps disclosures", async (t) => {
    const { page, emit } = await fixture(t);
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

  await t.test("visible thoughts and collapsed tools keep compact spacing at desktop and narrow widths", async (t) => {
    const { page } = await fixture(t);
    for (const width of [1440, 960]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(200);
      await page.screenshot({ path: `/tmp/citropy-activity-${width}.png`, animations: "disabled" });
      assert.equal(await page.locator(".reason-text").count(), 3);
      const rows = await page.locator(".reason-text, .group").evaluateAll(nodes => nodes.map(node => {
        const { y, height } = node.getBoundingClientRect();
        return { y, height };
      }));
      for (let index = 1; index < rows.length; index++) {
        const gap = rows[index].y - rows[index - 1].y - rows[index - 1].height;
        assert.ok(gap >= 0 && gap <= 8, JSON.stringify({ width, index, gap }));
      }
    }
  });

  await t.test("long workspace names truncate inside a resizing sidebar", async (t) => {
    const { page } = await fixture(t);
    const selector = page.getByRole("button", { name: `Choose workspace, ${project.name}`, exact: true });
    for (const width of [1440, 960, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const rail = await page.locator(".rail").boundingBox();
      const button = await selector.boundingBox();
      assert.ok(button.x >= rail.x && button.x + button.width <= rail.x + rail.width, JSON.stringify({ width, rail, button }));
      const label = await selector.locator("span").evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth, overflow: getComputedStyle(element).textOverflow }));
      assert.ok(label.scroll > label.client);
      assert.equal(label.overflow, "ellipsis");
      const chevron = await selector.locator("svg").last().boundingBox();
      assert.ok(chevron.x + chevron.width < button.x + button.width);
      await selector.click();
      await page.getByRole("menuitem", { name: new RegExp(`^${project.name} `) }).waitFor();
      await page.keyboard.press("Escape");
    }
  });

  await t.test("a live response folds once it finishes and can reveal its thoughts and diffs again", async (t) => {
    const { page, emit } = await fixture(t);
    const details = page.getByRole("button", { name: /^Work details/ });
    await details.waitFor();
    assert.equal(await details.getAttribute("aria-expanded"), "true");
    emit({ t: "part.add", threadId: "chat", messageId: "response", part: { id: "answer", kind: "text", text: "The music preview is ready. Run python music_splice.py to play it.", complete: false } });
    await page.locator('[data-part-id="answer"]').waitFor();
    assert.equal(await details.getAttribute("aria-expanded"), "true");
    emit({ t: "part.patch", threadId: "chat", messageId: "response", partId: "answer", patch: { complete: true } });
    assert.equal(await details.getAttribute("aria-expanded"), "true");
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
        const separator = document.querySelector(".work-separator").getBoundingClientRect();
        const answer = document.querySelector(".agent-card").getBoundingClientRect();
        return { above: separator.top - summary.bottom, below: answer.top - separator.bottom, height: separator.height };
      });
      assert.ok(spacing.height >= 1 && spacing.above >= 8 && spacing.below >= 8, JSON.stringify(spacing));
      assert.ok(Math.abs(spacing.above - spacing.below) <= 2, JSON.stringify({ width, ...spacing }));
      assert.equal(await details.locator("svg.activity-icon").count(), 1);
    }
    await details.click();
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

  await t.test("long work histories stay windowed when opened and settle on the visible final answer", async (t) => {
    const { page, emit } = await fixture(t);
    const content = Array.from({ length: 120 }, (_, index) => [
      { id: `long-thought-${index}`, kind: "reasoning", text: `Check the timing for section ${index}.`, complete: true },
      tool(`long-tool-${index}`, "read", `section-${index}.txt`),
    ]).flat();
    emit({ t: "thread.messages", threadId: "chat", messages: [{ id: "long-response", role: "assistant", ts: 1, parts: content }] });
    await page.locator(".group-label").last().waitFor();
    await page.waitForFunction(() => {
      const canvas = document.querySelector(".canvas");
      return canvas.scrollHeight > canvas.clientHeight && canvas.scrollHeight - canvas.scrollTop - canvas.clientHeight < 2;
    });
    assert.ok(await page.locator(".timeline-row").count() < 40);
    emit({ t: "part.add", threadId: "chat", messageId: "long-response", part: { id: "long-answer", kind: "text", text: "All 120 sections are ready.", complete: true } });
    emit({ t: "thread.upsert", thread: { ...thread, running: false, status: "idle" } });
    await page.locator('.activity-head[aria-expanded="false"]').waitFor();
    await page.locator('[data-part-id="long-answer"]').waitFor();
    assert.equal(await page.locator(".timeline-row").count(), 2);
    const details = page.getByRole("button", { name: /^Work details/ });
    for (let index = 0; index < 4; index++) {
      await details.click();
      await page.locator(".reason-text").first().waitFor();
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
