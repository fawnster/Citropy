#!/usr/bin/env node
import * as acp from "@agentclientprotocol/sdk";
import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";

const record = (entry) => {
  if (process.env.FAKE_ACP_LOG) appendFileSync(process.env.FAKE_ACP_LOG, `${JSON.stringify(entry)}\n`);
};

if (process.argv[2] === "--version") {
  process.stdout.write("fake-cursor 1.0.0\n");
  process.exit(0);
}

const modelDefs = {
  default: { label: "Auto" },
  "fake-fast": { label: "Fake Fast", effort: { id: "effort", values: ["low", "high"] }, fast: ["false", "true"] },
  "fake-smart": { label: "Fake Smart", effort: { id: "reasoning", values: ["none", "low", "medium", "high", "xhigh"] }, context: ["300k", "1m"] },
};
const modelParams = {
  "fake-fast": { effort: "low", fast: "false" },
  "fake-smart": { reasoning: "medium", context: "300k" },
};

let currentModel = "fake-fast";
let currentMode = "agent";
let cancelled = false;
let sessionId = "";

const requireSignIn = () => {
  if (process.env.FAKE_ACP_SIGNED_OUT) throw acp.RequestError.authRequired();
};

const select = (id, name, category, values, currentValue) => ({
  id,
  name,
  category,
  type: "select",
  currentValue,
  options: values.map((value) => ({ value, name: value })),
});

function optionsFor(model, withMode) {
  const definition = modelDefs[model];
  const params = modelParams[model] ?? {};
  const options = [];
  if (withMode) options.push(select("mode", "Mode", "mode", ["agent", "plan", "ask"], currentMode));
  options.push({
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: model,
    options: Object.entries(modelDefs).map(([value, entry]) => ({ value, name: entry.label })),
  });
  if (definition.effort)
    options.push(select(definition.effort.id, definition.effort.id === "effort" ? "Effort" : "Reasoning", "thought_level", definition.effort.values, params[definition.effort.id] ?? definition.effort.values[0]));
  if (definition.fast) options.push(select("fast", "Fast", "model_config", definition.fast, params.fast ?? definition.fast[0]));
  if (definition.context) options.push(select("context", "Context", "model_config", definition.context, params.context ?? definition.context[0]));
  return options;
}

const notifications = (client, messageId, chunks) => chunks.map((chunk) => client.notify(acp.methods.client.session.update, {
  sessionId,
  update: { sessionUpdate: chunk.kind, messageId, content: { type: "text", text: chunk.text } },
}));

const app = acp.agent({ name: "fake-cursor" })
  .onRequest(acp.methods.agent.initialize, (context) => {
    record({ method: "initialize", parameterized: context.params.clientCapabilities?._meta?.parameterizedModelPicker === true });
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: true, sse: false },
        promptCapabilities: { image: true, audio: false, embeddedContext: false },
      },
      authMethods: [{ id: "cursor_login", name: "Cursor Login" }],
      agentInfo: { name: "fake-cursor", version: "1.0.0" },
    };
  })
  .onRequest(acp.methods.agent.authenticate, (context) => {
    record({ method: "authenticate", methodId: context.params.methodId });
    return {};
  })
  .onRequest(acp.methods.agent.session.new, (context) => {
    record({ method: "session/new", mcpServers: context.params.mcpServers, cwd: context.params.cwd });
    requireSignIn();
    sessionId = `fake-${Date.now()}`;
    return {
      sessionId,
      modes: { currentModeId: currentMode, availableModes: ["agent", "plan", "ask"].map((value) => ({ id: value, name: value })) },
      configOptions: optionsFor(currentModel, true),
    };
  })
  .onRequest(acp.methods.agent.session.load, () => ({ configOptions: optionsFor(currentModel, true) }))
  .onRequest("cursor/list_available_models", { parse: (value) => value }, () => {
    requireSignIn();
    return { models: Object.entries(modelDefs).map(([value, definition]) => ({ value, name: definition.label, configOptions: optionsFor(value, false) })) };
  })
  .onRequest(acp.methods.agent.session.setMode, (context) => {
    currentMode = context.params.modeId;
    record({ method: "session/set_mode", modeId: currentMode });
    return {};
  })
  .onRequest(acp.methods.agent.session.setConfigOption, (context) => {
    const { configId, value } = context.params;
    if (configId === "model") {
      if (!modelDefs[value]) throw new Error(`Invalid model value: ${value}`);
      currentModel = value;
    } else {
      modelParams[currentModel][configId] = value;
    }
    record({ method: "session/set_config_option", configId, value });
    return { configOptions: optionsFor(currentModel, true) };
  })
  .onRequest(acp.methods.agent.session.prompt, async (context) => {
    const text = context.params.prompt.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    const images = context.params.prompt.filter((block) => block.type === "image").length;
    const links = context.params.prompt.filter((block) => block.type === "resource_link").length;
    record({ method: "session/prompt", text, images, links });
    cancelled = false;
    if (text.includes("slow")) {
      while (!cancelled) await new Promise((resolve) => setTimeout(resolve, 20));
      return { stopReason: "cancelled" };
    }
    await notifications(context.client, "thought-1", [{ kind: "agent_thought_chunk", text: "Checking the request." }]);
    await notifications(context.client, "message-1", [{ kind: "agent_message_chunk", text: "Working on it." }]);
    await context.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Run the checks", kind: "execute", status: "pending", rawInput: { command: "npm test" } },
    });
    await context.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "plan",
        entries: [
          { content: "Run the checks", priority: "high", status: "in_progress" },
          { content: "Report the result", priority: "low", status: "pending" },
        ],
      },
    });
    await context.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "simplify", description: "Simplify the change", input: { hint: "[path]" } }] },
    });
    await notifications(context.client, undefined, [{ kind: "agent_message_chunk", text: "Before tools." }]);
    await context.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "tool_call", toolCallId: "mcp-1", title: "MCP: tool", kind: "other", status: "pending", rawInput: {} },
    });
    await context.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "tool_call_update", toolCallId: "mcp-1", rawInput: { providerIdentifier: "citropy", toolName: "ask_user", args: { questions: [] } } },
    });
    const mcpPermission = await context.client.request(acp.methods.client.session.requestPermission, {
      sessionId,
      toolCall: { toolCallId: "mcp-1" },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    record({ method: "mcp-permission", outcome: mcpPermission.outcome });
    await context.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "tool_call_update", toolCallId: "mcp-1", status: "completed" },
    });
    await context.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "tool_call", toolCallId: "plan-tool", title: "Create Plan", kind: "other", status: "pending", rawInput: { _toolName: "createPlan" } },
    });
    await context.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "tool_call", toolCallId: "plan-late", title: "Create Plan", kind: "other", status: "pending", rawInput: {} },
    });
    await context.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "tool_call_update", toolCallId: "plan-late", rawInput: { _toolName: "createPlan", plan: "Late plan" } },
    });
    await notifications(context.client, undefined, [{ kind: "agent_message_chunk", text: "After tools." }]);
    await context.client.notify("cursor/update_todos", {
      toolCallId: "todo-1",
      merge: false,
      todos: [
        { content: "Run the checks", status: "in_progress" },
        { content: "Report the result", status: "pending" },
      ],
    });
    const question = await context.client.request("cursor/ask_question", {
      toolCallId: "tool-1",
      title: "Pick a check",
      questions: [
        { id: "check", prompt: "Which check should run?", options: [{ id: "fast", label: "Fast" }, { id: "full", label: "Full" }], allowMultiple: false },
      ],
    });
    record({ method: "cursor/ask_question", outcome: question.outcome });
    const plan = await context.client.request("cursor/create_plan", {
      toolCallId: "tool-1",
      name: "Checks",
      plan: "# Checks\n\nRun the checks.",
      todos: [{ content: "Report the result", status: "completed" }],
    });
    record({ method: "cursor/create_plan", outcome: plan.outcome });
    await context.client.notify("cursor/update_todos", {
      toolCallId: "todo-1",
      merge: true,
      todos: [{ content: "Report the result", status: "completed" }],
    });
    if (!text.includes("nopermission")) {
      const permission = await context.client.request(acp.methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId: "tool-1", title: "Run the checks", kind: "execute" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      });
      record({ method: "permission", outcome: permission.outcome });
    }
    await context.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "in_progress" },
    });
    await context.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "usage_update",
        used: 12000,
        size: 200000,
        cost: { amount: 0.02, currency: "USD" },
        _meta: { cachedReadTokens: 4000, cachedWriteTokens: 150, outputTokens: 300 },
      },
    });
    await context.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: "All checks passed" } },
          { type: "content", content: { type: "image", data: "aGVsbG8=", mimeType: "image/png" } },
        ],
      },
    });
    await notifications(context.client, "message-2", [{ kind: "agent_message_chunk", text: "Done." }]);
    return {
      stopReason: "end_turn",
      usage: {
        totalTokens: 12700,
        inputTokens: 2500,
        outputTokens: 800,
        cachedReadTokens: 9000,
        cachedWriteTokens: 400,
      },
    };
  })
  .onNotification(acp.methods.agent.session.cancel, () => {
    cancelled = true;
    record({ method: "session/cancel" });
  });

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);
app.connect(stream);
