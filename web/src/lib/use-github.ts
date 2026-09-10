import { useEffect, useState } from "react";
import { github } from "./actions.ts";
import { useApp } from "./store.ts";
import type {
  GitHubRequests,
  GitHubResponses,
} from "../../../shared/github.ts";

export function useGitHub<K extends keyof GitHubRequests>(
  operation: K,
  input: GitHubRequests[K] | null,
) {
  const connected = useApp((state) => state.connected);
  const key = JSON.stringify(input);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    data?: GitHubResponses[K];
    error?: string;
    loading: boolean;
  }>({ key, loading: true });
  useEffect(() => {
    let cancelled = false;
    if (!connected || key === "null") return;
    setResult((previous) => ({
      key,
      data: previous.key === key ? previous.data : undefined,
      loading: true,
    }));
    void github(operation, JSON.parse(key)).then(
      (data) => {
        if (!cancelled) setResult({ key, data, loading: false });
      },
      (error: Error) => {
        if (!cancelled)
          setResult((previous) => ({
            ...previous,
            key,
            error: error.message,
            loading: false,
          }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [operation, key, revision, connected]);
  return {
    data: key === result.key ? result.data : undefined,
    error:
      connected && key !== "null" && key === result.key
        ? result.error
        : undefined,
    loading:
      key !== "null" && connected && (key !== result.key || result.loading),
    refresh: () => setRevision((value) => value + 1),
  };
}
