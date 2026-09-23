import { create } from "zustand";

export type RemoteFolderRequest = { environmentId: string; host: string; path: string; resolve: (path: string | null) => void };

export const useRemoteFolderRequest = create<{ request: RemoteFolderRequest | null }>(() => ({ request: null }));

// Chooses a folder on an SSH host when the desktop has no SFTP-capable system chooser.
export function browseRemoteFolder(environmentId: string, host: string, path = ""): Promise<string | null> {
  useRemoteFolderRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRemoteFolderRequest.setState({ request: { environmentId, host, path, resolve } }));
}

export function finishRemoteFolder(request: RemoteFolderRequest, path: string | null): void {
  const pending = useRemoteFolderRequest.getState().request;
  if (pending !== request) return;
  useRemoteFolderRequest.setState({ request: null });
  pending?.resolve(path);
}
