import type { ProjectSettings } from "./protocol.ts";

export function resolveProjectSettings(
  defaults: Omit<ProjectSettings, "actions"> = {},
  overrides: ProjectSettings = {},
): ProjectSettings {
  const model = overrides.provider !== undefined ? overrides : defaults;
  return {
    provider: model.provider,
    model: model.model,
    effort: model.effort,
    permissionMode: overrides.permissionMode ?? defaults.permissionMode ?? "manual",
    workspace: overrides.workspace ?? defaults.workspace ?? "current",
    autoPull: overrides.autoPull ?? defaults.autoPull ?? false,
    browserAccess: overrides.browserAccess ?? defaults.browserAccess ?? true,
    actions: overrides.actions,
  };
}
