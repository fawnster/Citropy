import { searchConversations } from "../conversation-search.ts";
import { answer as answerPermission } from "../permissions.ts";
import { providerInfo } from "../provider-registry.ts";
import { disposeRuntime, runtimeFor, runtimeIfExists } from "../runtime.ts";
import { store } from "../store.ts";
import { chooseThreadWorkspace } from "../workspaces.ts";
import { modelSettings, selectedModel } from "../../shared/model-options.ts";
import type { ClientEvent, Thread } from "../../shared/protocol.ts";
import type { Routes } from "./types.ts";

type ConfigEvent = Extract<ClientEvent, { t: "thread.config" }>;
type Settings = ReturnType<typeof modelSettings>;

function hasHistory(thread: Thread): boolean {
  return Boolean(
    thread.messages.length ||
      thread.externalId ||
      thread.parentThreadId ||
      thread.running ||
      thread.queue?.length ||
      thread.compacting ||
      [...store.threads.values()].some((entry) => entry.parentThreadId === thread.id),
  );
}

function resolveConfig(thread: Thread, event: ConfigEvent): { changedProvider: boolean; changedModel: boolean; settings: Settings } {
  const changedProvider = event.provider !== undefined && event.provider !== thread.provider;
  const provider = providerInfo().find((entry) => entry.id === (event.provider ?? thread.provider));
  if (changedProvider) {
    if (!provider?.available || !provider.enabled) throw new Error("Select an enabled, installed provider.");
    if (hasHistory(thread)) throw new Error("Start a new thread to use a different provider after sending a message.");
  }
  const models = provider?.models ?? [];
  const model = selectedModel(models, event.model ?? (changedProvider ? undefined : thread.model));
  if (event.model && !model) throw new Error("This model is no longer available. Refresh the model list.");
  if (event.effort && !model?.efforts?.includes(event.effort))
    throw new Error("This effort is not supported by the selected model");
  if (event.contextWindow !== undefined && !model?.contextWindows?.includes(event.contextWindow))
    throw new Error("This context size is not supported by the selected model");
  if (event.fastMode !== undefined && (typeof event.fastMode !== "boolean" || (event.fastMode && !model?.fastMode)))
    throw new Error("Fast mode is not supported by the selected model");
  const changedModel = changedProvider || (event.model !== undefined && event.model !== thread.model);
  const settings = modelSettings(models, {
    model: event.model ?? (changedProvider ? model?.id : thread.model),
    effort: event.effort === null || changedModel ? (event.effort ?? undefined) : (event.effort ?? thread.effort),
    contextWindow: event.contextWindow ?? (changedModel ? undefined : thread.contextWindow),
    fastMode: event.fastMode ?? (changedModel ? false : thread.fastMode),
  });
  return { changedProvider, changedModel, settings };
}

export const threadRoutes: Routes = {
  "thread.create": async (event, send) => {
    const provider = providerInfo().find((entry) => entry.id === event.provider);
    if (!provider?.available) throw new Error("This provider is not available on this computer.");
    const project = store.projects.get(event.projectId);
    if (!project) throw new Error("Workspace not found");
    const workspace = await chooseThreadWorkspace(project, event.workspace);
    const thread = store.createThread({
      ...workspace,
      projectId: event.projectId,
      provider: event.provider,
      ...modelSettings(provider.models, {
        model: event.model,
        effort: event.effort ?? undefined,
        contextWindow: event.contextWindow,
        fastMode: event.fastMode,
      }),
      title: event.title ?? "New thread",
      permissionMode: event.permissionMode ?? "manual",
    });
    send({ t: "thread.messages", threadId: thread.id, messages: thread.messages });
  },
  "thread.send": async (event, send) => {
    await runtimeFor(event.threadId).send(event.text, event.attachments);
    if (event.requestId) send({ t: "thread.accepted", requestId: event.requestId });
  },
  "thread.stop": (event) => {
    runtimeFor(event.threadId).stop();
  },
  "thread.remove": (event) => {
    disposeRuntime(event.id);
    store.removeThread(event.id);
  },
  "thread.finish": (event) => {
    store.setThreadFinished(event.id, event.finished);
  },
  "thread.search": (event, send) => {
    send({
      t: "thread.search",
      query: event.query,
      projectId: event.projectId,
      results: searchConversations(store.threads.values(), event.query, event.projectId),
    });
  },
  "thread.load": (event, send) => {
    const thread = store.threads.get(event.id);
    if (thread) send({ t: "thread.messages", threadId: thread.id, messages: thread.messages });
  },
  "thread.config": async (event, send) => {
    const thread = store.threads.get(event.id);
    if (!thread) throw new Error("Conversation not found");
    const { changedProvider, changedModel, settings } = resolveConfig(thread, event);
    const restart =
      changedProvider ||
      Object.entries(settings).some(([key, value]) => thread[key as keyof Settings] !== value) ||
      (event.permissionMode !== undefined && event.permissionMode !== thread.permissionMode);
    if (restart && thread.running) throw new Error("Wait for this turn to finish before changing its settings.");
    let live = false;
    if (restart) {
      const existing = changedProvider ? undefined : runtimeIfExists(event.id);
      if (existing)
        live = await existing.configure({
          model: settings.model,
          effort: settings.effort,
          contextMax: settings.contextWindow,
          fastMode: settings.fastMode,
          permissionMode: event.permissionMode ?? thread.permissionMode,
        });
      if (!live) disposeRuntime(event.id, true);
    }
    store.patchThread(event.id, {
      provider: event.provider ?? thread.provider,
      ...settings,
      // A live reconfigure already reported the real window through its session event.
      ...(!live && (changedModel || settings.contextWindow !== thread.contextWindow)
        ? { usage: { ...thread.usage, contextMax: 0 } }
        : {}),
      permissionMode: event.permissionMode ?? thread.permissionMode,
      title: event.title ?? thread.title,
    });
    if (event.requestId) send({ t: "thread.accepted", requestId: event.requestId });
  },
  "queue.send": async (event) => {
    await runtimeFor(event.threadId).sendNow(event.id);
  },
  "queue.remove": async (event) => {
    await runtimeFor(event.threadId).removeQueued(event.id);
  },
  "queue.move": (event) => {
    runtimeFor(event.threadId).moveQueued(event.id, event.index);
  },
  "queue.edit": (event, send) => {
    runtimeFor(event.threadId).takeQueued(event.id);
    send({ t: "thread.accepted", requestId: event.requestId });
  },
  "permission.answer": (event) => {
    answerPermission(event.id, event.decision);
  },
};
