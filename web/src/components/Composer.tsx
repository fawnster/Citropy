import { environmentId, environmentSignal, environmentStorage, serverUrl } from "../lib/environment.ts";
import { ComposerInput } from "./ComposerInput.tsx";
import { gitActionBusy } from "../../../shared/assistance.ts";
import { Attachments } from "./Attachments.tsx";
import { QueueList } from "./QueueList.tsx";
import { api, reportError } from "../lib/api.ts";
import type { Attachment, QueuedMessage } from "../../../shared/protocol.ts";
import type { ComposerDraft } from "../../../shared/features.ts";
import type { PanelTab } from "../../../shared/workbench.ts";
import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  Square,
  Brain,
  Layers,
  Zap,
  ShieldCheck,
  Pencil,
  ListChecks,
} from "./icons.ts";
import {
  Paperclip,
  BookOpen,
  Minimize2,
  BarChart3,
  LoaderCircle,
  LockKeyhole,
  UnlockKeyhole,
  Play,
} from "lucide-react";
import {
  effectiveEffort,
  selectedModel,
} from "../../../shared/model-options.ts";
import { ContextUsage } from "./ContextUsage.tsx";
import { send } from "../lib/socket.ts";
import { Menu } from "./Menu.tsx";
import {
  configureThread,
  sendMessage,
  stopThread,
  loadThread,
} from "../lib/actions.ts";
import { selectThread, selectPanel, useApp } from "../lib/store.ts";
import {
  effortLabel as formatEffort,
} from "../lib/format.ts";
import type { PermissionMode } from "../../../shared/protocol.ts";
import { useI18n } from "../lib/i18n.ts";
import { ModelPicker } from "./ModelPicker.tsx";

const MODES: Array<{
  id: PermissionMode;
  label: string;
  hint: string;
  icon: typeof ShieldCheck;
}> = [
  {
    id: "manual",
    label: "Ask before changes",
    hint: "Review tools before they run",
    icon: LockKeyhole,
  },
  {
    id: "acceptEdits",
    label: "Auto edits",
    hint: "Allow file edits; ask for other actions",
    icon: Pencil,
  },
  {
    id: "plan",
    label: "Plan only",
    hint: "Explore and plan without editing files",
    icon: ListChecks,
  },
  {
    id: "bypass",
    label: "Full access",
    hint: "Allow tools without approval prompts",
    icon: UnlockKeyhole,
  },
];

const contextLabel = (size: number) =>
  size >= 1_000_000 ? `${size / 1_000_000}M` : `${Math.round(size / 1000)}k`;

export function Composer({
  onUsage,
  onSkills,
}: {
  onUsage?: () => void;
  onSkills?: () => void;
}) {
  const t = useI18n();
  const [scope] = useState(environmentId);
  const [scopeSignal] = useState(environmentSignal);
  const threadId = useApp((state) => state.activeThreadId);
  const thread = useApp((state) =>
    threadId ? state.threads[threadId] : undefined,
  );
  const connected = useApp((state) => state.connected);
  const providers = useApp((state) => state.providers);
  const hasMessages = useApp((state) => Boolean(threadId && state.order[threadId]?.length));
  const project = useApp((state) =>
    state.projects.find((entry) => entry.id === thread?.projectId),
  );
  const [draft] = useState<ComposerDraft>(() => {
    try {
      const saved = JSON.parse(
        environmentStorage.getItem(`citropy.draft.${threadId}`, scope) || "{}",
      );
      return {
        text: typeof saved.text === "string" ? saved.text : "",
        attachments: Array.isArray(saved.attachments)
          ? saved.attachments
              .filter(
                (file: Attachment) =>
                  file &&
                  typeof file.id === "string" &&
                  typeof file.path === "string",
              )
              .slice(0, 8)
          : [],
      };
    } catch {
      return { text: "", attachments: [] };
    }
  });
  const [value, setValue] = useState(draft.text);
  const [attachments, setAttachments] = useState<Attachment[]>(
    draft.attachments,
  );
  const [uploading, setUploading] = useState("");
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadAbort = useRef(new AbortController());
  const modelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    uploadAbort.current = new AbortController();
    return () => uploadAbort.current.abort();
  }, []);
  useEffect(() => {
    if (threadId)
      environmentStorage.setItem(
        `citropy.draft.${threadId}`,
        JSON.stringify({ text: value, attachments }),
        scope,
      );
  }, [threadId, value, attachments, scope]);
  const upload = async (files: File[]) => {
    if (!threadId || uploading) return;
    if (attachments.length + files.length > 8) {
      reportError(new Error(t("Attach up to 8 files per message.")));
      return;
    }
    try {
      for (const file of files) {
        if (file.size > 50 * 1024 * 1024)
          throw new Error(t("{name} exceeds the 50 MB file limit.", { name: file.name }));
        setUploading(file.name);
        const response = await fetch(
          serverUrl(`/api/attachments?${new URLSearchParams({ threadId, name: file.name })}`),
          { method: "POST", body: file, signal: AbortSignal.any([uploadAbort.current.signal, scopeSignal]) },
        );
        const result = await response.json();
        scopeSignal.throwIfAborted();
        if (!response.ok) throw new Error(result.error || t("Upload failed."));
        setAttachments((previous) => [...previous, result]);
      }
    } catch (error) {
      reportError(error);
    } finally {
      setUploading("");
    }
  };
  const compact = () => {
    if (threadId)
      void api(`threads/compact?threadId=${threadId}`, {
        method: "POST",
      }).catch(reportError);
  };
  const restore = (item: QueuedMessage) => {
    setValue((previous) =>
      previous.trim() ? `${item.text}\n\n${previous}` : item.text,
    );
    setAttachments((previous) => [...(item.attachments ?? []), ...previous]);
  };
  const effortButton = useRef<HTMLButtonElement>(null);
  const permissionButton = useRef<HTMLButtonElement>(null);

  const running = thread?.running ?? false;
  const provider = providers.find((entry) => entry.id === thread?.provider);
  const canSend =
    !sending &&
    !thread?.compacting &&
    !gitActionBusy(thread?.gitAction) &&
    !uploading &&
    Boolean(provider?.enabled && provider.available);
  const mode =
    MODES.find((entry) => entry.id === thread?.permissionMode) ?? MODES[0];
  const model = selectedModel(provider?.models ?? [], thread?.model);

  const effort = effectiveEffort(model, thread?.effort);
  const effortLabel = effort ? formatEffort(effort) : t("Model options");
  const contextWindow = thread?.contextWindow ?? model?.contextMax;
  const ModeIcon = mode?.icon ?? ShieldCheck;

  const commands = [
    {
      id: "compact",
      label: "/compact",
      hint: t("Compact context and keep the visible history"),
      icon: <Minimize2 size={16} />,
      run: compact,
    },
    {
      id: "usage",
      label: "/usage",
      hint: t("See usage and remaining allowance"),
      icon: <BarChart3 size={16} />,
      run: () => onUsage?.(),
    },
    {
      id: "skills",
      label: "/skills",
      hint: t("Manage installed skills"),
      icon: <BookOpen size={16} />,
      run: () => onSkills?.(),
    },
    {
      id: "model",
      label: "/model",
      hint: t("Choose a model"),
      icon: <Brain size={16} />,
      run: () => modelButton.current?.click(),
    },
    {
      id: "plan",
      label: "/plan",
      hint: t("Switch to Plan only permissions"),
      icon: <ListChecks size={16} />,
      run: () => {
        if (threadId) configureThread(threadId, { permissionMode: "plan" });
      },
    },
    ...(model?.efforts?.length ||
    model?.contextWindows?.length ||
    model?.fastMode
      ? [
          {
            id: "effort",
            label: "/effort",
            hint: t("Choose reasoning effort and context size"),
            icon: <Brain size={16} />,
            run: () => effortButton.current?.click(),
          },
        ]
      : []),
    ...(model?.fastMode
      ? [
          {
            id: "fast",
            label: "/fast",
            hint: thread?.fastMode ? t("Turn fast mode off") : t("Turn fast mode on"),
            icon: <Zap size={16} />,
            run: () => {
              if (threadId)
                configureThread(threadId, { fastMode: !thread?.fastMode });
            },
          },
        ]
      : []),
    {
      id: "permissions",
      label: "/permissions",
      hint: t("Choose tool permissions"),
      icon: <ShieldCheck size={16} />,
      run: () => permissionButton.current?.click(),
    },
    ...(project?.settings?.actions ?? []).map((action) => ({
      id: action.id,
      label: `/run ${action.name}`,
      hint: t("Run in this conversation's workspace"),
      icon: <Play size={16} />,
      run: () => {
        if (!thread) return;
        void api<PanelTab>(
          `projects/action?projectId=${thread.projectId}&threadId=${thread.id}`,
          { method: "POST", body: JSON.stringify({ id: action.id }) },
        )
          .then((panel) => selectPanel(panel.id))
          .catch(reportError);
      },
    })),
  ];
  const submit = async () => {
    const text = value.trim();
    if ((!text && !attachments.length) || !threadId || !canSend) return;
    const command = commands.find((entry) => entry.label === text);
    if (command) {
      if (
        running &&
        ["compact", "model", "plan", "effort", "permissions", "fast"].includes(
          command.id,
        )
      )
        return;
      command.run();
      setValue("");
      return;
    }
    setSending(true);
    try {
      await sendMessage(text, attachments);
      setAttachments([]);
      setValue("");
    } catch (error) {
      reportError(error);
    } finally {
      setSending(false);
    }
  };

  if (!thread) return null;
  if (thread.nativeAgentId && thread.parentThreadId)
    return (
      <div className="composer">
        <div className="subagent-managed">
          {t("This subagent is managed by its parent conversation.")}
          <button
            type="button"
            className="btn"
            onClick={() => {
              selectThread(thread.parentThreadId!);
              loadThread(thread.parentThreadId!);
            }}
          >{" "}{t("Back to parent chat")}{" "}</button>
        </div>
      </div>
    );

  return (
    <div className="composer">
      {thread.parentThreadId && (
        <div className="subagent-managed">
          {t("Subagent conversation")}
          <button
            type="button"
            onClick={() => {
              selectThread(thread.parentThreadId!);
              loadThread(thread.parentThreadId!);
            }}
          >
            {t("Back to parent chat")}
          </button>
        </div>
      )}
      {thread.finished && (
        <div className="composer-finished" role="status">
          {t("This conversation is finished. Send a message to reopen it.")}
        </div>
      )}
      {provider && !provider.enabled && (
        <div className="models-warning" role="status">
          {t("{provider} is disabled. Enable it in Settings > Providers to continue this conversation.", { provider: provider.label })}
        </div>
      )}
      {provider?.modelsError && (
        <div className="models-warning" role="status">
          {provider.modelsError}
        </div>
      )}
      <QueueList thread={thread} provider={provider} onEdit={restore} />
      <div
        className="composer-shell"
        data-dragging={dragging}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void upload(Array.from(event.dataTransfer.files));
        }}
      >
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          aria-label={t("Attach files")}
          onChange={(event) => {
            void upload(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        {attachments.length > 0 && (
          <Attachments
            files={attachments}
            projectId={thread.projectId}
            threadId={thread.id}
            onRemove={(id) => {
              setAttachments((previous) =>
                previous.filter((file) => file.id !== id),
              );
              void api(`attachments?threadId=${thread.id}&id=${id}`, {
                method: "DELETE",
              }).catch(reportError);
            }}
          />
        )}
        {uploading && (
          <div className="upload-progress" role="status">
            <LoaderCircle size={15} className="spin" />
            {t("Uploading {name}…", { name: uploading })}
          </div>
        )}
        <ComposerInput
          value={value}
          onChange={setValue}
          onSubmit={submit}
          onFiles={(files) => void upload(files)}
          disabled={sending}
          thread={thread}
          commands={commands}
        />
        <div className="composer-bar">
          <ModelPicker
            value={{ provider: thread.provider, model: thread.model ?? model?.id ?? "default" }}
            label={t("Model")}
            buttonRef={modelButton}
            className="composer-select composer-model"
            disabled={running || !connected || sending}
            lockedProvider={hasMessages || thread.externalId || thread.usage.turns || thread.queue?.length ? thread.provider : undefined}
            onChange={(choice) => { if (choice) configureThread(thread.id, { ...choice, effort: null }); }}
          />

          {Boolean(
            model?.efforts?.length ||
              model?.contextWindows?.length ||
              model?.fastMode,
          ) && (
            <Menu
              width={280}
              items={[
                ...(model?.efforts ?? []).map((value) => ({
                  id: `effort-${value}`,
                  section: t("Reasoning effort"),
                  icon: <Brain size={16} className="option-reasoning" />,
                  label: formatEffort(value),
                  selected: effort === value,
                  onSelect: () => configureThread(thread.id, { effort: value }),
                })),
                ...(model?.contextWindows ?? []).map((size) => ({
                  id: `context-${size}`,
                  section: t("Context window"),
                  icon: <Layers size={16} className="option-context" />,
                  label: `${contextLabel(size)} tokens`,
                  selected: contextWindow === size,
                  onSelect: () =>
                    configureThread(thread.id, { contextWindow: size }),
                })),
                ...(model?.fastMode
                  ? [true, false].map((on) => ({
                      id: `fast-${on}`,
                      section: t("Fast mode"),
                      icon: (
                        <Zap
                          size={16}
                          className={on ? "option-fast" : "muted"}
                        />
                      ),
                      label: on ? t("On") : t("Off"),
                      hint: on
                        ? (model.fastModeHint ?? t("Faster responses, increased usage"))
                        : t("Standard speed and usage"),
                      selected: Boolean(thread.fastMode) === on,
                      onSelect: () =>
                        configureThread(thread.id, { fastMode: on }),
                    }))
                  : []),
              ]}
              trigger={({ toggle, id, open }) => (
                <button
                  id={id}
                  aria-haspopup="menu"
                  aria-expanded={open}
                  className="composer-select"
                  type="button"
                  disabled={running}
                  onClick={toggle}
                  ref={effortButton}
                  title={t("Model options")}
                  aria-label={`${t("Model options")}: ${effortLabel}${contextWindow ? `, ${contextLabel(contextWindow)} ${t("context")}` : ""}${thread.fastMode ? `, ${t("fast mode on")}` : ""}`}
                >
                  {thread.fastMode ? (
                    <Zap size={14} className="option-fast" />
                  ) : (
                    <Brain size={14} className="option-reasoning" />
                  )}
                  <span>
                    {effort
                      ? effortLabel
                      : contextWindow
                        ? contextLabel(contextWindow)
                        : t("Options")}
                  </span>
                  {effort && contextWindow && (
                    <span className="composer-context">
                      {contextLabel(contextWindow)}
                    </span>
                  )}
                  <ChevronDown size={11} />
                </button>
              )}
            />
          )}

          <Menu
            header={t("Permissions")}
            width={290}
            items={MODES.map((entry) => ({
              id: entry.id,
              label: t(entry.label),
              icon: (
                <entry.icon
                  size={17}
                  className={`option-permission ${entry.id}`}
                />
              ),
              hint: t(entry.hint),
              selected: entry.id === thread.permissionMode,
              onSelect: () =>
                configureThread(thread.id, { permissionMode: entry.id }),
            }))}
            trigger={({ toggle, id, open }) => (
              <button
                id={id}
                aria-haspopup="menu"
                aria-expanded={open}
                className="composer-select"
                type="button"
                disabled={running}
                onClick={toggle}
                ref={permissionButton}
                data-tone={thread.permissionMode}
              >
                <ModeIcon
                  size={14}
                  className={`option-permission ${thread.permissionMode}`}
                />
                <span className="truncate">{mode && t(mode.label)}</span>
                <ChevronDown size={11} className="muted" />
              </button>
            )}
          />

          <div className="composer-actions">
            <ContextUsage onCompact={compact} />
            <button
              className="icon-btn"
              type="button"
              title={t("Attach images or files")}
              aria-label={t("Attach images or files")}
              disabled={!connected || Boolean(uploading)}
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip size={17} className="attachment-file-icon" />
            </button>

            {running ? (
              <>
                <button
                  className="btn"
                  type="button"
                  data-variant="primary"
                  onClick={submit}
                  disabled={(!value.trim() && !attachments.length) || !canSend}
                >
                  <ArrowUp size={13} />
                  {t("Queue")}
                </button>
                <button
                  className="btn"
                  type="button"
                  data-variant="danger"
                  onClick={stopThread}
                >
                  <Square size={11} fill="currentColor" />
                  {t("Stop")}
                </button>
              </>
            ) : (
              <button
                className="btn"
                type="button"
                data-variant="primary"
                onClick={submit}
                disabled={(!value.trim() && !attachments.length) || !canSend}
              >
                <ArrowUp size={13} />
                {t("Send")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
