import { Attachments } from "./Attachments.tsx";
import { memo, type ReactNode } from "react";
import { PartView } from "./PartView.tsx";
import { WorkGroup } from "./WorkGroup.tsx";
import { WorkDetails } from "./WorkDetails.tsx";
import { Reasoning } from "./parts/Reasoning.tsx";
import { MessageActions } from "./MessageActions.tsx";
import type { TimelineRow } from "../lib/timeline.ts";
import { useApp } from "../lib/store.ts";
import { UserRound } from "lucide-react";
import { useI18n } from "../lib/i18n.ts";
import { ProviderIcon } from "./ProviderIcon.tsx";
import { selectedModel } from "../../../shared/model-options.ts";
import {
  clock,
  modelLabel,
  modelSource,
  providerLabels,
} from "../lib/format.ts";

interface Props extends Omit<TimelineRow, "key" | "messageId"> {
  messageId?: string;
  streaming: boolean;
  children?: ReactNode;
  transitionActivity?: (id: string, update: () => void) => void;
}

export const MessageBlock = memo(function MessageBlock({
  messageId,
  streaming,
  row,
  first,
  last,
  separator,
  children,
  transitionActivity,
}: Props) {
  const t = useI18n();
  const shell = useApp((state) => messageId ? state.messages[messageId] : undefined);
  const partKind = useApp((state) => row?.kind === "part" ? state.parts[row.id]?.kind : undefined);
  const provider = useApp((state) =>
    shell?.provider ?? (state.activeThreadId
      ? state.threads[state.activeThreadId]?.provider
      : undefined),
  );
  const threadModel = useApp((state) =>
    state.activeThreadId
      ? state.threads[state.activeThreadId]?.model
      : undefined,
  );
  const providers = useApp((state) => state.providers);

  const thread = useApp((state) => state.threads[state.activeThreadId ?? ""]);
  const account = useApp((state) =>
    state.showGitHubIdentity && messageId && state.messages[messageId]?.role === "user"
      ? state.githubAccount
      : null,
  );

  if (!shell && (messageId !== undefined || !thread)) return null;

  if (shell?.role === "user") {
    return (
      <article id={`message-${messageId}`} className="turn turn-user">
        <div
          className="message-avatar user-avatar"
          aria-label={account?.login ?? t("You")}
        >
          <UserRound size={17} />
          {account?.avatar_url && (
            <img
              key={account.avatar_url}
              src={account.avatar_url}
              alt=""
              referrerPolicy="no-referrer"
              onError={(event) => {
                event.currentTarget.hidden = true;
              }}
            />
          )}
        </div>
        <div className="message-content">
          <div className="turn-heading">
            <strong>{account?.login ?? t("You")}</strong>
            <time>{clock(shell.ts)}</time>
            {thread && messageId && <MessageActions thread={thread} messageId={messageId} user />}
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
  const modelId = shell?.model ?? threadModel;
  const modelName = modelLabel(catalog?.models ?? [], modelId);
  const model = selectedModel(catalog?.models ?? [], modelId);
  const activity = Boolean(row && row.kind !== "part") || Boolean(partKind && partKind !== "text");

  return (
    <article
      id={first && messageId ? `message-${messageId}` : undefined}
      className="turn turn-agent"
      data-continuation={!first || undefined}
      data-last={last}
      data-activity={activity || undefined}
      data-working={Boolean(children) || undefined}
    >
      {first && (
        <div className="message-avatar agent-avatar" aria-label={modelName}>
          {provider && <ProviderIcon provider={provider} />}
        </div>
      )}
      <div className="message-content">
        {first && (
          <div className="turn-heading">
            {thread && messageId && !streaming && <MessageActions thread={thread} messageId={messageId} user={false} />}
            <strong>{modelName}</strong>
            {provider && (
              <span
                className="turn-provider"
                title={modelSource(catalog, model)}
              >
                {catalog?.label ?? providerLabels[provider]}
              </span>
            )}
            <time>{clock(shell?.ts ?? thread?.runStartedAt ?? thread?.updatedAt ?? 0)}</time>
          </div>
        )}
        {separator && <hr className="work-separator" />}
        {row && (
          <div className={activity ? "agent-activity" : "message-bubble agent-card"}>
            {row.kind === "activity" ? (
              <WorkDetails id={row.id} ids={row.ids} messageIds={row.messageIds} open={row.open} active={row.active} previewId={row.previewId} transitionActivity={transitionActivity} />
            ) : row.kind === "group" ? (
              <WorkGroup key={row.ids[0]} ids={row.ids} />
            ) : row.kind === "thoughts" ? (
              <Reasoning ids={row.ids} live={streaming} />
            ) : (
              <PartView key={row.id} partId={row.id} live={streaming} />
            )}
          </div>
        )}
        {children}
      </div>
    </article>
  );
});
