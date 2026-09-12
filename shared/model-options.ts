import type { ModelOption, ThreadMeta } from "./protocol.ts";

export function selectedModel(
  models: ModelOption[],
  id?: string,
): ModelOption | undefined {
  if (!id || id === "default")
    return models.find((model) => model.isDefault) ?? models[0];
  for (const candidate of [id, id.replace(/\[1m\]$/i, "")]) {
    const model = models.find(
      (model) =>
        model.id === candidate ||
        model.resolvedModel === candidate ||
        model.aliases?.includes(candidate),
    );
    if (model) return model;
  }
  return undefined;
}

export function effectiveEffort(
  model: ModelOption | undefined,
  effort?: string | null,
): string | undefined {
  const supported = model?.efforts ?? [];
  if (effort && supported.includes(effort)) return effort;
  if (model?.defaultEffort && supported.includes(model.defaultEffort))
    return model.defaultEffort;
  return supported.includes("high")
    ? "high"
    : supported.includes("medium")
      ? "medium"
      : supported[0];
}

export function modelSettings(
  models: ModelOption[],
  selection: Pick<
    ThreadMeta,
    "model" | "effort" | "contextWindow" | "fastMode"
  >,
): Pick<ThreadMeta, "model" | "effort" | "contextWindow" | "fastMode"> {
  const model = selectedModel(models, selection.model);
  if (!model) return selection;
  return {
    model: model.id,
    effort: effectiveEffort(model, selection.effort),
    contextWindow: model.contextWindows?.includes(selection.contextWindow ?? 0)
      ? selection.contextWindow
      : model.contextMax,
    fastMode: Boolean(model.fastMode && selection.fastMode),
  };
}
