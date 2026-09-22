import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

const stored = new Map(Object.entries({
  "loom.theme": "dark",
  "citropy.uiScale": "invalid",
  "citropy.typingSpeed": "301",
  "citropy.uiSoundVolume": "140",
  "citropy.language": "invalid",
  "citropy.sidebar": "0",
  "citropy.gitPanel": "1",
  "citropy.panelWidths": JSON.stringify({ sidebar: 320, inspector: -1, git: "240", unknown: 500 }),
  "citropy.favoriteModels": JSON.stringify([{ provider: "claude", model: "preferred" }, { provider: "unknown", model: "invalid" }]),
  "citropy.threadDefaults": JSON.stringify({ provider: "unknown" }),
  "citropy.offline": "[]",
}));
globalThis.localStorage = {
  get length() { return stored.size; },
  key: index => [...stored.keys()][index] ?? null,
  getItem: key => stored.get(key) ?? null,
  setItem: (key, value) => stored.set(key, String(value)),
  removeItem: key => stored.delete(key),
};
const properties = new Map();
globalThis.document = { documentElement: { dataset: {}, style: { setProperty: (key, value) => properties.set(key, value) } } };
const store = await import("../web/src/lib/store.ts");
const preferences = await import("../web/src/lib/preferences.ts");
const { useApp } = await import("../web/src/lib/app-state.ts");
const initial = useApp.getState();

afterEach(() => {
  useApp.setState(initial, true);
  stored.clear();
  properties.clear();
  document.documentElement.dataset = {};
});

test("the shared app state loads migrated preferences with existing validation and defaults", () => {
  assert.strictEqual(store.useApp, useApp);
  assert.equal(initial.theme, "dark");
  assert.equal(stored.get("citropy.theme"), "dark");
  assert.equal(stored.has("loom.theme"), false);
  assert.equal(initial.uiScale, 120);
  assert.equal(initial.typingSpeed, 100);
  assert.equal(initial.uiSoundVolume, 100);
  assert.equal(initial.language, "en");
  assert.equal(initial.sidebarOpen, false);
  assert.equal(initial.gitPanelOpen, true);
  assert.deepEqual(initial.panelWidths, { sidebar: 320 });
  assert.deepEqual(initial.favoriteModels, [{ provider: "claude", model: "preferred" }]);
  assert.equal(initial.threadDefaults, null);
  assert.deepEqual(initial.offline, {});
  assert.equal(initial.notificationPreferences.subagents, false);
});

test("preference actions keep the public store API, persistence and DOM updates in sync", () => {
  for (const name of Object.keys(preferences)) assert.strictEqual(store[name], preferences[name], name);
  for (const [action, field] of [
    [store.setTextStreaming, "textStreaming"],
    [store.setTypingAnimation, "typingAnimation"],
    [store.setShowGitHubIdentity, "showGitHubIdentity"],
    [store.setUiSounds, "uiSounds"],
    [store.setUiAlertSounds, "uiAlertSounds"],
  ]) {
    for (const value of [false, true]) {
      action(value);
      assert.equal(useApp.getState()[field], value);
      assert.equal(stored.get(`citropy.${field}`), value ? "1" : "0");
    }
  }
  for (const [action, field, input, expected] of [
    [store.setUiScale, "uiScale", 180, 150],
    [store.setUiScale, "uiScale", 10, 90],
    [store.setTypingSpeed, "typingSpeed", 501, 300],
    [store.setTypingSpeed, "typingSpeed", 10, 20],
    [store.setUiSoundVolume, "uiSoundVolume", 101, 100],
    [store.setUiSoundVolume, "uiSoundVolume", -1, 0],
  ]) {
    action(input);
    assert.equal(useApp.getState()[field], expected);
    assert.equal(stored.get(`citropy.${field}`), String(expected));
    const previous = useApp.getState();
    action(NaN);
    assert.strictEqual(useApp.getState(), previous);
  }
  assert.equal(properties.get("--ui-scale"), "0.9");
  store.setTheme("light");
  assert.equal(useApp.getState().theme, "light");
  assert.equal(stored.get("citropy.theme"), "light");
  assert.equal(document.documentElement.dataset.theme, "light");
  store.setLanguage("es");
  store.setLanguage("invalid");
  assert.equal(useApp.getState().language, "es");
  assert.equal(stored.get("citropy.language"), "es");
});

test("panel and favorite actions update the same store without changing prior snapshots", () => {
  store.setPanelWidth("inspector", 250.8);
  store.setPanelWidth("sidebar");
  const previous = useApp.getState();
  store.setPanelWidth("git", 0);
  assert.strictEqual(useApp.getState(), previous);
  assert.deepEqual(previous.panelWidths, { inspector: 251 });
  assert.deepEqual(initial.panelWidths, { sidebar: 320 });
  assert.deepEqual(JSON.parse(stored.get("citropy.panelWidths")), previous.panelWidths);
  store.toggleInspector();
  store.toggleSidebar();
  assert.equal(stored.get("citropy.inspector"), useApp.getState().inspectorOpen ? "1" : "0");
  assert.equal(stored.get("citropy.sidebar"), useApp.getState().sidebarOpen ? "1" : "0");
  const favorite = { provider: "codex", model: "selected" };
  store.toggleFavoriteModel(favorite);
  assert.deepEqual(useApp.getState().favoriteModels, [...initial.favoriteModels, favorite]);
  store.toggleFavoriteModel(favorite);
  assert.deepEqual(useApp.getState().favoriteModels, initial.favoriteModels);
  assert.deepEqual(JSON.parse(stored.get("citropy.favoriteModels")), initial.favoriteModels);
});

test("environment reset reloads workspace state while preserving display preferences", async () => {
  store.setTheme("light");
  store.setTypingSpeed(180);
  const confirmation = store.confirmAction({ title: "Pending", description: "Pending choice", label: "Confirm" });
  stored.set("citropy.project", "next-project");
  stored.set("citropy.thread", "next-thread");
  stored.set("citropy.offline", JSON.stringify({ "next-thread": [{ id: "queued", text: "Later" }] }));
  useApp.setState({ connected: true, activeThreadId: "old", parts: { old: { id: "old", kind: "text", text: "Old" } } });
  store.resetEnvironment([{ id: "next-project", path: "/next", name: "Next" }], "/next");
  assert.equal(await confirmation, false);
  const state = useApp.getState();
  assert.equal(state.theme, "light");
  assert.equal(state.typingSpeed, 180);
  assert.equal(state.activeProjectId, "next-project");
  assert.equal(state.activeThreadId, "next-thread");
  assert.equal(state.offline["next-thread"][0].text, "Later");
  assert.deepEqual(state.parts, {});
  assert.equal(state.connected, false);
  assert.equal(state.confirmation, null);
});
