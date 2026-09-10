import { useApp } from "./store.ts";

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
    signal:
      options.signal ??
      AbortSignal.timeout(path.startsWith("computer/start") ? 135_000 : path.startsWith("browser/import") ? 125_000 : 90_000),
  });
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error(
      "This feature is unavailable. Restart the Citropy server and try again.",
    );
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data.error || `Request failed (${response.status}).`);
  return data as T;
}

export function reportError(error: unknown): void {
  if ((error as Error).name === "AbortError") return;
  useApp.setState((state) => ({
    toasts: [
      ...state.toasts,
      {
        id: crypto.randomUUID(),
        level: "error",
        text: (error as Error).message || "This action could not be completed.",
      },
    ],
  }));
}

export function assetQuery(
  projectId: string,
  path: string,
  threadId?: string,
  attachmentId?: string,
): string {
  return new URLSearchParams({
    projectId,
    path,
    ...(threadId ? { threadId } : {}),
    ...(attachmentId ? { attachmentId } : {}),
  }).toString();
}
