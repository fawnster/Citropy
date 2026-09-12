import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { WebSocketServer } from "ws";
import { chromium } from "playwright";

test(
  "workspace and attachment flows render and operate at desktop and narrow widths",
  { timeout: 90000 },
  async (t) => {
    const directory = fs.mkdtempSync(join(os.tmpdir(), "citropy-feature-ui-"));
    const originalHome = os.homedir;
    const env = {
      CODEX_HOME: process.env.CODEX_HOME,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    };
    os.homedir = () => directory;
    process.env.CODEX_HOME = join(directory, ".codex");
    process.env.CLAUDE_CONFIG_DIR = join(directory, ".claude");
    process.env.XDG_CONFIG_HOME = join(directory, ".config");
    syncBuiltinESMExports();
    const { store } = await import("../server/store.ts");
    const { handleFeatures } = await import("../server/features.ts");
    const { bus } = await import("../server/bus.ts");
    const { runtimeFor, disposeAll } = await import("../server/runtime.ts");
    const { providers } = await import("../server/providers/index.ts");
    const repo = join(directory, "workspace");
    fs.mkdirSync(repo);
    fs.writeFileSync(
      join(repo, "notes.md"),
      "# Example project\n\nA file to preview.",
    );
    fs.mkdirSync(join(repo, ".claude/skills/review"), { recursive: true });
    fs.writeFileSync(
      join(repo, ".claude/skills/review/SKILL.md"),
      "---\nname: review\ndescription: Review changes with the project's conventions.\n---\nRead the changed files.",
    );
    for (const args of [
      ["init", "-b", "main"],
      ["config", "user.email", "test@example.invalid"],
      ["config", "user.name", "Test"],
      ["add", "."],
      ["commit", "-m", "Initial"],
    ])
      execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    const project = store.openProject(repo);
    const catalog = [
      {
        id: "claude",
        label: "Claude Code",
        available: true,
        enabled: true,
        models: [
          {
            id: "fixture",
            label: "Claude Fixture",
            isDefault: true,
            efforts: ["low", "high"],
            defaultEffort: "high",
            contextMax: 200000,
          },
        ],
      },
    ];
    providers.claude.models = catalog[0].models;
    let lastAttachments;
    providers.claude.start = (options) => {
      options.emit({ type: "session", externalId: "fixture" });
      return {
        send: async (_text, attachments) => {
          lastAttachments = attachments;
          setTimeout(() => {
            options.emit({
              type: "block.start",
              blockId: "text",
              block: "text",
            });
            options.emit({
              type: "block.delta",
              blockId: "text",
              text: "I received the image and the file.",
            });
            options.emit({ type: "block.end", blockId: "text" });
            options.emit({ type: "turn.end" });
          }, 50);
        },
        compact: async () => {
          setTimeout(
            () => options.emit({ type: "compacted", contextTokens: 100 }),
            50,
          );
        },
        interrupt() {},
        dispose() {},
      };
    };
    const vite = await createServer({
      configFile: false,
      cacheDir: join(directory, "cache"),
      root: fileURLToPath(new URL("..", import.meta.url)),
      plugins: [react()],
      logLevel: "error",
      server: { middlewareMode: true, hmr: false },
    });
    const server = http.createServer(async (req, res) => {
      if (req.url === "/api/usage") {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            totals: {
              input: 123456,
              output: 1234,
              cacheRead: 80000,
              cacheWrite: 1000,
              costUsd: 0.08,
            },
            providers: [
              {
                provider: "claude",
                updatedAt: Date.now(),
                windows: [
                  {
                    label: "5 hours",
                    usedPercent: 24,
                    resetsAt: Date.now() + 3600000,
                  },
                  { label: "Weekly", usedPercent: 40 },
                ],
              },
            ],
            conversations: [...store.threads.values()],
          }),
        );
        return;
      }
      if (await handleFeatures(req, res, catalog)) return;
      vite.middlewares(req, res);
    });
    const wss = new WebSocketServer({ server, path: "/socket" });
    wss.on("connection", (socket) => {
      const send = (event) => {
        if (socket.readyState === socket.OPEN)
          socket.send(JSON.stringify(event));
      };
      send({
        t: "hello",
        snapshot: {
          home: directory,
          projects: [...store.projects.values()],
          threads: store.allMeta(),
          providers: catalog,
          permissions: [],
        },
      });
      const unsubscribe = bus.subscribe(send);
      socket.on("close", unsubscribe);
      socket.on("message", async (raw) => {
        const event = JSON.parse(raw);
        if (event.t === "thread.load")
          send({
            t: "thread.messages",
            threadId: event.id,
            messages: store.threads.get(event.id)?.messages ?? [],
          });
        if (event.t === "thread.send") {
          try {
            await runtimeFor(event.threadId).send(
              event.text,
              event.attachments,
            );
            send({ t: "thread.accepted", requestId: event.requestId });
          } catch (error) {
            send({
              t: "request.error",
              requestId: event.requestId,
              error: error.message,
            });
          }
        }
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch({
      headless: true,
      channel: "chromium",
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const consoleErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.addInitScript(() => {
      if (window.top !== window) return;
      localStorage.setItem("citropy.theme", "dark");
      localStorage.setItem("citropy.inspector", "0");
      localStorage.setItem("citropy.uiScale", "110");
    });
    t.after(async () => {
      await browser.close();
      for (const socket of wss.clients) socket.terminate();
      await new Promise((resolve) => wss.close(resolve));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await vite.close();
      disposeAll();
      store.flush();
      os.homedir = originalHome;
      for (const [key, value] of Object.entries(env))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      syncBuiltinESMExports();
      fs.rmSync(directory, { recursive: true, force: true });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page
      .getByRole("complementary", { name: "Conversations" })
      .getByRole("button", { name: "New thread", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Provider", exact: true })
      .selectOption("claude");
    await page.getByRole("radio", { name: /New worktree/ }).click();
    await page.getByLabel("Branch name").fill("feature/attachments");
    await page
      .getByRole("button", { name: "Create conversation", exact: true })
      .waitFor();
    await page.screenshot({
      animations: "disabled",
      path: "/tmp/citropy-feature-new-conversation.png",
    });
    await page
      .getByRole("button", { name: "Create conversation", exact: true })
      .click();
    await page.getByLabel("Message", { exact: true }).waitFor();
    const thread = [...store.threads.values()][0];
    assert.equal(thread.workspaceBranch, "feature/attachments");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNfcAAAAASUVORK5CYII=",
      "base64",
    );
    await page.getByLabel("Attach files", { exact: true }).setInputFiles([
      { name: "example.png", mimeType: "image/png", buffer: png },
      {
        name: "notes.md",
        mimeType: "text/markdown",
        buffer: Buffer.from("# Attached notes\n\nThese reach the provider."),
      },
    ]);
    await page
      .getByRole("button", { name: "Preview example.png", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Preview notes.md", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Preview example.png", exact: true })
      .click();
    await page.locator(".media-preview img").waitFor();
    await page.waitForFunction(
      () => document.querySelector(".media-preview img")?.naturalWidth > 0,
    );
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page
      .getByLabel("Message", { exact: true })
      .fill("Please inspect these attachments.");
    await page.getByLabel("Message", { exact: true }).press("Enter");
    await page
      .getByText("I received the image and the file.", { exact: true })
      .waitFor();
    assert.equal(lastAttachments.length, 2);
    assert.equal(
      await page.getByLabel("Message", { exact: true }).inputValue(),
      "",
    );
    await page
      .getByRole("button", { name: "Preview notes.md", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Attached notes", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByLabel("Message", { exact: true }).fill("/compact");
    await page.getByLabel("Message", { exact: true }).press("Enter");
    await page
      .getByText(
        "Context compacted. Your conversation history is still available here.",
        { exact: true },
      )
      .waitFor();
    await page.screenshot({
      animations: "disabled",
      path: "/tmp/citropy-feature-chat.png",
    });
    const pdfContent = "BT /F1 20 Tf 30 140 Td (PDF attachment preview) Tj ET";
    const pdfObjects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      `<< /Length ${pdfContent.length} >>\nstream\n${pdfContent}\nendstream`,
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    pdfObjects.forEach((object, index) => {
      offsets.push(pdf.length);
      pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)
      .join(
        "\n",
      )}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    await page.getByLabel("Attach files", { exact: true }).setInputFiles([
      {
        name: "document.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from(pdf),
      },
      {
        name: "page.html",
        mimeType: "text/html",
        buffer: Buffer.from(
          "<h1>HTML attachment preview</h1><script>parent.document.title='unsafe-preview'</script>",
        ),
      },
    ]);
    await page
      .getByRole("button", { name: "Preview page.html", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Preview document.pdf", exact: true })
      .click();
    let pdfFrame;
    for (let attempt = 0; attempt < 100 && !pdfFrame; attempt++) {
      for (const frame of page.frames())
        if (
          await frame
            .locator("embed[type='application/x-google-chrome-pdf']")
            .count()
            .catch(() => 0)
        )
          pdfFrame = frame;
      if (!pdfFrame) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(pdfFrame, JSON.stringify(consoleErrors));
    await pdfFrame.locator("embed").waitFor();
    await page.screenshot({
      animations: "disabled",
      path: "/tmp/citropy-feature-pdf.png",
    });
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page
      .getByRole("button", { name: "Preview page.html", exact: true })
      .click();
    await page
      .frameLocator("iframe.html-preview")
      .getByRole("heading", { name: "HTML attachment preview", exact: true })
      .waitFor();
    assert.notEqual(await page.title(), "unsafe-preview");
    await page.getByRole("button", { name: "Source", exact: true }).click();
    await page.locator(".preview-body code").filter({ hasText: "HTML attachment preview" }).waitFor();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Usage", exact: true }).click();
    await page.getByText("76% left", { exact: true }).waitFor();
    await page.screenshot({
      animations: "disabled",
      path: "/tmp/citropy-feature-usage.png",
    });
    await page
      .getByRole("button", { name: "Back to chat", exact: true })
      .click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await page.getByLabel("Project name").fill("Design workspace");
    await page
      .getByRole("button", { name: "Save settings", exact: true })
      .click();
    await page.getByText("Project settings saved", { exact: true }).waitFor();
    assert.equal(store.projects.get(project.id).name, "Design workspace");
    await page.screenshot({
      animations: "disabled",
      path: "/tmp/citropy-feature-project-settings.png",
    });
    await page.getByRole("button", { name: "Skills", exact: true }).click();
    const enable = page.getByRole("switch", {
      name: "Enable review for claude",
      exact: true,
    });
    await enable.waitFor();
    await enable.click();
    await page.getByText(/3 enabled · 4 installed/).waitFor();
    await enable.click();
    await page.getByText(/4 enabled · 4 installed/).waitFor();
    await page.screenshot({
      animations: "disabled",
      path: "/tmp/citropy-feature-skills.png",
    });
    await page.getByRole("button", { name: "Resources", exact: true }).click();
    await page
      .getByRole("heading", { name: "Citropy processes", exact: true })
      .waitFor();
    await page.screenshot({
      animations: "disabled",
      path: "/tmp/citropy-feature-resources.png",
    });
    await page.setViewportSize({ width: 960, height: 900 });
    await page.screenshot({
      animations: "disabled",
      path: "/tmp/citropy-feature-narrow.png",
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    assert.deepEqual(errors, []);
  },
);
