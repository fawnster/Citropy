import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeTodos } from "../shared/todos.ts";
import { buildRows } from "../web/src/lib/group.ts";

test("plan items preserve provider text and status across supported formats", () => {
  assert.deepEqual(normalizeTodos([
    { content: "Inspect container configuration", status: "in_progress", priority: "high" },
    { content: "Start the service", status: "pending", activeForm: "Starting the service" },
    { step: "Verify the address", status: "inProgress" },
    { text: "Check logs", status: "completed" },
    { content: "Replace the configuration", status: "cancelled" },
    { text: " ", content: " Keep the existing backup ", status: "pending" },
  ]), [
    { text: "Inspect container configuration", status: "in_progress" },
    { text: "Start the service", status: "pending" },
    { text: "Verify the address", status: "in_progress" },
    { text: "Check logs", status: "completed" },
    { text: "Replace the configuration", status: "cancelled" },
    { text: "Keep the existing backup", status: "pending" },
  ]);
});

test("empty or partial plan data does not create blank steps or timeline rows", () => {
  for (const input of [undefined, null, {}, [null, false, "step", {}, { content: " " }, { text: 42 }]]) {
    assert.deepEqual(normalizeTodos(input), []);
  }
  assert.deepEqual(buildRows([{ id: "empty", kind: "todo", items: [{ content: "" }] }]), []);
  assert.deepEqual(buildRows([{ id: "saved", kind: "todo", items: [{ content: "Existing plan", status: "pending" }] }]), [{ kind: "part", id: "saved" }]);
  assert.deepEqual(normalizeTodos([{ content: "Keep readable text", status: "unknown" }]), [{ text: "Keep readable text", status: "pending" }]);
});
