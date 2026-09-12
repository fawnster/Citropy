import { Attachments } from "./Attachments.tsx";
import { memo } from "react";
import { PartView } from "./PartView.tsx";
import { WorkGroup } from "./WorkGroup.tsx";
import type { TimelineRow } from "../lib/timeline.ts";
import { useApp } from "../lib/store.ts";
import { UserRound } from "lucide-react";
import { ProviderIcon } from "./ProviderIcon.tsx";
import { selectedModel } from "../../../shared/model-options.ts";
import {
  clock,
  modelLabel,
  modelSource,
  providerLabels,
} from "../lib/format.ts";

interface Props extends Omit<TimelineRow, "key"> {
  streaming: boolean;
}

export const MessageBlock = memo(function MessageBlock({
  messageId,
  streaming,
  row,
  first,
  last,
}: Props) {
  const shell = useApp((state) => state.messages[messageId]);
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
          <div className="message-bubble user-card">
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
  const model = selectedModel(catalog?.models ?? [], modelId);

  return (
    <article
      id={first ? `message-${messageId}` : undefined}
      className="turn turn-agent"
      data-continuation={!first || undefined}
      data-last={last}
    >
      {first && (
        <div className="message-avatar agent-avatar" aria-label={modelName}>
          {provider && <ProviderIcon provider={provider} />}
        </div>
      )}
      <div className="message-content">
        {first && (
          <div className="turn-heading">
            <strong>{modelName}</strong>
            {provider && (
              <span
                className="turn-provider"
                title={modelSource(catalog, model)}
              >
                {catalog?.label ?? providerLabels[provider]}
              </span>
            )}
            <time>{clock(shell.ts)}</time>
          </div>
        )}
        {row && (
          <div className="message-bubble agent-card">
            {row.kind === "group" ? (
              <WorkGroup key={row.ids[0]} ids={row.ids} />
            ) : (
              <PartView key={row.id} partId={row.id} live={streaming} />
            )}
          </div>
        )}
      </div>
    </article>
  );
});
