import assert from "node:assert/strict";
import { test } from "node:test";
import { searchConversations } from "../server/conversation-search.ts";

test("search finds saved message content, scopes workspaces and returns the matching message", () => {
  const threads = [
    { id: "a", projectId: "one", title: "Unrelated title", updatedAt: 1, messages: [{ id: "m1", parts: [{ kind: "text", text: "The folder contains random_numbers.txt" }] }] },
    { id: "b", projectId: "two", title: "Folder task", updatedAt: 2, messages: [{ id: "m2", parts: [{ kind: "text", text: "Another FOLDER" }] }] },
  ];
  assert.deepEqual(searchConversations(threads, "FOLDER", "one"), [{ threadId: "a", messageId: "m1", snippet: "The folder contains random_numbers.txt" }]);
  assert.deepEqual(searchConversations(threads, "folder").map((result) => result.threadId), ["b", "a"]);
  assert.equal(searchConversations(threads, "Unrelated")[0].messageId, undefined);
  assert.deepEqual(searchConversations(threads, "   "), []);
  assert.deepEqual(searchConversations(threads, "missing"), []);
});
