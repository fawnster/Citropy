import assert from "node:assert/strict";
import { test } from "node:test";
import { codexModels, claudeModels, openCodeModels, discoverModels } from "../server/providers/models.ts";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";

test("catalogs preserve provider-specific efforts and exclude hidden models", () => {
  const models = codexModels([
    { model: "new-model", displayName: "New model", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "ultra" }] },
    { model: "hidden", displayName: "Hidden", hidden: true },
  ]);
  assert.equal(models.length, 1);
  assert.deepEqual(models[0].efforts, ["high", "ultra"]);
  assert.equal(models[0].defaultEffort, "high");
  assert.equal(models[0].isDefault, true);
  assert.deepEqual(claudeModels([{ value: "fast", displayName: "Fast" }])[0].efforts, []);
  assert.deepEqual(claudeModels([{ value: "reasoning", displayName: "Reasoning", supportsEffort: true, supportedEffortLevels: ["low", "max"] }])[0].efforts, ["low", "max"]);
});

test("OpenCode metadata includes all models and their own variants", () => {
  const output = Array.from({ length: 75 }, (_, i) => `provider/model-${i}\n${JSON.stringify({ id: `model-${i}`, name: `Model ${i}`, providerID: "provider", variants: i ? { high: {} } : {}, limit: { context: 100000 } }, null, 2)}`).join("\n");
  const models = openCodeModels(output);
  assert.equal(models.length, 75);
  assert.deepEqual(models[0].efforts, []);
  assert.deepEqual(models[1].efforts, ["high"]);
  assert.equal(models[1].contextMax, 100000);
  assert.throws(() => openCodeModels("not a catalog"));
});

test("Codex discovery follows pagination and never sends a user turn", async () => {
  const original = childProcess.spawn;
  const requests = [];
  let killed = false;
  childProcess.spawn = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = () => { killed = true; queueMicrotask(() => child.emit("exit", 0)); };
    child.stdin.on("data", (chunk) => {
      const request = JSON.parse(String(chunk));
      requests.push(request);
      queueMicrotask(() => {
        if (request.method === "initialize") child.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\n");
        if (request.method === "model/list") child.stdout.write(JSON.stringify({ id: 2, result: { data: [{ model: request.params.cursor ? "second" : "first", displayName: "Model" }], nextCursor: request.params.cursor ? null : "next" } }) + "\n");
      });
    });
    return child;
  };
  syncBuiltinESMExports();
  try {
    assert.deepEqual((await discoverModels("codex")).map((model) => model.id), ["first", "second"]);
    assert.deepEqual(requests.map((request) => request.method), ["initialize", "initialized", "model/list", "model/list"]);
    assert.equal(killed, true);
  } finally {
    childProcess.spawn = original;
    syncBuiltinESMExports();
  }
});

test("Claude aliases become named models with real context and fast-mode capabilities", () => {
  const options = {
    resolvedModel: "claude-opus-5[1m]",
    description: "Opus 5 with 1M context",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "max"],
    supportsFastMode: true,
  };
  const models = claudeModels([
    { ...options, value: "default", displayName: "Default (recommended)" },
    { ...options, value: "opus[1m]", displayName: "Opus (1M context)" },
    {
      value: "haiku",
      resolvedModel: "claude-haiku-4-5-20251001",
      displayName: "Haiku",
    },
  ]);
  assert.equal(models.length, 2);
  assert.equal(models[0].id, "claude-opus-5");
  assert.equal(models[0].label, "Claude Opus 5");
  assert.equal(models[0].isDefault, true);
  assert.deepEqual(models[0].contextWindows, [200000, 1000000]);
  assert.equal(models[0].fastMode, true);
  assert.equal(models[1].fastMode, false);
  assert.equal(models[1].label, "Claude Haiku 4.5");
  assert.ok(models[0].aliases.includes("default"));
  assert.ok(models.every((model) => !/default/i.test(model.label)));
});

test("effective options resolve old aliases and remove unsupported selections on model changes", async () => {
  const { modelSettings, effectiveEffort } =
    await import("../shared/model-options.ts");
  const models = [
    {
      id: "named",
      label: "Named",
      aliases: ["default", "old[1m]"],
      isDefault: true,
      efforts: ["low", "medium", "high"],
      defaultEffort: "medium",
      contextMax: 1000000,
      contextWindows: [200000, 1000000],
      fastMode: true,
    },
    { id: "small", label: "Small", efforts: [] },
  ];
  assert.deepEqual(modelSettings(models, { model: "default" }), {
    model: "named",
    effort: "medium",
    contextWindow: 1000000,
    fastMode: false,
  });
  assert.deepEqual(
    modelSettings(models, {
      model: "old[1m]",
      effort: "high",
      contextWindow: 200000,
      fastMode: true,
    }),
    { model: "named", effort: "high", contextWindow: 200000, fastMode: true },
  );
  assert.deepEqual(
    modelSettings(models, {
      model: "small",
      effort: "high",
      contextWindow: 1000000,
      fastMode: true,
    }),
    {
      model: "small",
      effort: undefined,
      contextWindow: undefined,
      fastMode: false,
    },
  );
  assert.equal(effectiveEffort(models[0], "unknown"), "medium");
  assert.equal(codexModels([{ model: "legacy", displayName: "Legacy", additionalSpeedTiers: ["fast"] }])[0].fastModeTier, "fast");
  assert.equal(
    codexModels([
      {
        model: "fast",
        displayName: "Fast",
        serviceTiers: [{ id: "priority", description: "2x speed" }],
      },
    ])[0].fastMode,
    true,
  );
  assert.equal(
    codexModels([{ model: "standard", displayName: "Standard" }])[0].fastMode,
    false,
  );
});
