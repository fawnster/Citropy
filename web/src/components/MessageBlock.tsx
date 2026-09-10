import { Attachments } from "./Attachments.tsx";
import { memo, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { PartView } from "./PartView.tsx";
import { WorkGroup } from "./WorkGroup.tsx";
import { buildRows } from "../lib/group.ts";
import { useApp } from "../lib/store.ts";
import { UserRound } from "lucide-react";
import { ProviderIcon } from "./ProviderIcon.tsx";
import {
  clock,
  modelLabel,
  modelSource,
  providerLabels,
} from "../lib/format.ts";

interface Props {
  messageId: string;
  streaming: boolean;
}

export const MessageBlock = memo(function MessageBlock({
  messageId,
  streaming,
}: Props) {
  const shell = useApp((state) => state.messages[messageId]);
  const parts = useApp(
    useShallow((state) => (shell?.partIds ?? []).map((id) => state.parts[id])),
  );
  const provider = useApp((state) =>
    state.activeThreadId
      ? state.threads[state.activeThreadId]?.provider
      : undefined,
  );
  const threadModel = useApp((state) =>
    state.activeThreadId
      ? state.threads[state.activeThreadId]?.model
      : undefined,
  );
  const providers = useApp((state) => state.providers);

  const thread = useApp((state) => state.threads[state.activeThreadId ?? ""]);
  const rows = useMemo(() => buildRows(parts), [parts]);

  if (!shell) return null;

  if (shell.role === "user") {
    return (
      <article id={`message-${messageId}`} className="turn turn-user">
        <div className="message-avatar user-avatar" aria-label="You">
          <UserRound size={17} />
        </div>
        <div className="message-content">
          <div className="turn-heading">
            <strong>You</strong>
            <time>{clock(shell.ts)}</time>
          </div>
          {shell.attachments?.length && thread ? (
            <Attachments
              files={shell.attachments}
              projectId={thread.projectId}
              threadId={thread.id}
            />
          ) : null}
          <div className="user-card">
            {shell.partIds.map((id) => (
              <PartView key={id} partId={id} live={false} />
            ))}
          </div>
        </div>
      </article>
    );
  }

  const catalog = providers.find((entry) => entry.id === provider);
  const modelId = shell.model ?? threadModel;
  const modelName = modelLabel(catalog?.models ?? [], modelId);
  const model = catalog?.models.find(
    (entry) => entry.id === modelId || entry.resolvedModel === modelId,
  );

  return (
    <article id={`message-${messageId}`} className="turn turn-agent">
      <div className="message-avatar agent-avatar" aria-label={modelName}>
        {provider && <ProviderIcon provider={provider} />}
      </div>
      <div className="message-content">
        <div className="turn-heading">
          <strong>{modelName}</strong>
          {provider && (
            <span className="turn-provider" title={modelSource(catalog, model)}>
              {catalog?.label ?? providerLabels[provider]}
            </span>
          )}
          <time>{clock(shell.ts)}</time>
        </div>
        {rows.map((row) =>
          row.kind === "group" ? (
            <WorkGroup key={row.ids[0]} ids={row.ids} />
          ) : (
            <PartView key={row.id} partId={row.id} live={streaming} />
          ),
        )}
      </div>
    </article>
  );
});
