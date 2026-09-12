import { ComposerInput } from "./ComposerInput.tsx";
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
import { ProviderIcon } from "./ProviderIcon.tsx";
import { Menu } from "./Menu.tsx";
import {
  configureThread,
  sendMessage,
  stopThread,
  loadThread,
} from "../lib/actions.ts";
import { selectThread, selectPanel, useApp } from "../lib/store.ts";
import {
  modelSource,
  modelLabel,
  effortLabel as formatEffort,
} from "../lib/format.ts";
import type { PermissionMode } from "../../../shared/protocol.ts";

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
  const threadId = useApp((state) => state.activeThreadId);
  const thread = useApp((state) =>
    threadId ? state.threads[threadId] : undefined,
  );
  const connected = useApp((state) => state.connected);
  const providers = useApp((state) => state.providers);
  const project = useApp((state) =>
    state.projects.find((entry) => entry.id === thread?.projectId),
  );
  const [draft] = useState<ComposerDraft>(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem(`citropy.draft.${threadId}`) || "{}",
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
      localStorage.setItem(
        `citropy.draft.${threadId}`,
        JSON.stringify({ text: value, attachments }),
      );
  }, [threadId, value, attachments]);
  const upload = async (files: File[]) => {
    if (!threadId || uploading) return;
    if (attachments.length + files.length > 8) {
      reportError(new Error("Attach up to 8 files per message."));
      return;
    }
    try {
      for (const file of files) {
        if (file.size > 50 * 1024 * 1024)
          throw new Error(`${file.name} exceeds the 50 MB file limit.`);
        setUploading(file.name);
        const response = await fetch(
          `/api/attachments?${new URLSearchParams({ threadId, name: file.name })}`,
          { method: "POST", body: file, signal: uploadAbort.current.signal },
        );
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Upload failed.");
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
    !uploading &&
    Boolean(provider?.enabled && provider.available);
  const mode =
    MODES.find((entry) => entry.id === thread?.permissionMode) ?? MODES[0];
  const model = selectedModel(provider?.models ?? [], thread?.model);

  const effort = effectiveEffort(model, thread?.effort);
  const effortLabel = effort ? formatEffort(effort) : "Model options";
  const contextWindow = thread?.contextWindow ?? model?.contextMax;
  const ModeIcon = mode?.icon ?? ShieldCheck;

  const commands = [
    {
      id: "compact",
      label: "/compact",
      hint: "Compact context and keep the visible history",
      icon: <Minimize2 size={16} />,
      run: compact,
    },
    {
      id: "usage",
      label: "/usage",
      hint: "See usage and remaining allowance",
      icon: <BarChart3 size={16} />,
      run: () => onUsage?.(),
    },
    {
      id: "skills",
      label: "/skills",
      hint: "Manage installed skills",
      icon: <BookOpen size={16} />,
      run: () => onSkills?.(),
    },
    {
      id: "model",
      label: "/model",
      hint: "Choose a model",
      icon: <Brain size={16} />,
      run: () => modelButton.current?.click(),
    },
    {
      id: "plan",
      label: "/plan",
      hint: "Switch to Plan only permissions",
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
            hint: "Choose reasoning effort and context size",
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
            hint: thread?.fastMode ? "Turn fast mode off" : "Turn fast mode on",
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
      hint: "Choose tool permissions",
      icon: <ShieldCheck size={16} />,
      run: () => permissionButton.current?.click(),
    },
    ...(project?.settings?.actions ?? []).map((action) => ({
      id: action.id,
      label: `/run ${action.name}`,
      hint: "Run in this conversation's workspace",
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
          This subagent is managed by its parent conversation.
          <button
            type="button"
            className="btn"
            onClick={() => {
              selectThread(thread.parentThreadId!);
              loadThread(thread.parentThreadId!);
            }}
          >
            Back to parent chat
          </button>
        </div>
      </div>
    );

  return (
    <div className="composer">
      {thread.parentThreadId && (
        <div className="subagent-managed">
          Subagent conversation
          <button
            type="button"
            onClick={() => {
              selectThread(thread.parentThreadId!);
              loadThread(thread.parentThreadId!);
            }}
          >
            Back to parent chat
          </button>
        </div>
      )}
      {thread.finished && (
        <div className="composer-finished" role="status">
          This conversation is finished. Send a message to reopen it.
        </div>
      )}
      {provider && !provider.enabled && (
        <div className="models-warning" role="status">
          {provider.label} is disabled. Enable it in Settings &gt; Providers to
          continue this conversation.
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
          aria-label="Attach files"
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
            Uploading {uploading}…
          </div>
        )}
        {thread.compacting && (
          <div className="upload-progress" role="status">
            <Minimize2 size={15} />
            Compacting context…
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
          <Menu
            header={
              provider?.modelsError ? "Models · refresh unavailable" : "Model"
            }
            width={320}
            searchable
            items={(provider?.models ?? []).map((entry) => ({
              id: entry.id,
              label: entry.label,
              icon: <ProviderIcon provider={thread.provider} />,
              hint: modelSource(provider, entry),
              selected: entry.id === model?.id,
              onSelect: () =>
                configureThread(thread.id, { model: entry.id, effort: null }),
            }))}
            trigger={({ toggle, id, open }) => (
              <button
                ref={modelButton}
                id={id}
                aria-haspopup="menu"
                aria-expanded={open}
                className="composer-select composer-model"
                type="button"
                disabled={running}
                onClick={() => {
                  send({ t: "providers.refresh" });
                  toggle();
                }}
              >
                <ProviderIcon provider={thread.provider} />
                <span className="truncate">
                  {modelLabel(provider?.models ?? [], thread.model)}
                </span>
                <span className="composer-provider">{provider?.label}</span>
                <ChevronDown size={11} className="muted" />
              </button>
            )}
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
                  section: "Reasoning effort",
                  icon: <Brain size={16} className="option-reasoning" />,
                  label: formatEffort(value),
                  selected: effort === value,
                  onSelect: () => configureThread(thread.id, { effort: value }),
                })),
                ...(model?.contextWindows ?? []).map((size) => ({
                  id: `context-${size}`,
                  section: "Context window",
                  icon: <Layers size={16} className="option-context" />,
                  label: `${contextLabel(size)} tokens`,
                  selected: contextWindow === size,
                  onSelect: () =>
                    configureThread(thread.id, { contextWindow: size }),
                })),
                ...(model?.fastMode
                  ? [true, false].map((on) => ({
                      id: `fast-${on}`,
                      section: "Fast mode",
                      icon: (
                        <Zap
                          size={16}
                          className={on ? "option-fast" : "muted"}
                        />
                      ),
                      label: on ? "On" : "Off",
                      hint: on
                        ? (model.fastModeHint ??
                          "Faster responses, increased usage")
                        : "Standard speed and usage",
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
                  title="Model options"
                  aria-label={`Model options: ${effortLabel}${contextWindow ? `, ${contextLabel(contextWindow)} context` : ""}${thread.fastMode ? ", fast mode on" : ""}`}
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
                        : "Options"}
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
            header="Permissions"
            width={290}
            items={MODES.map((entry) => ({
              id: entry.id,
              label: entry.label,
              icon: (
                <entry.icon
                  size={17}
                  className={`option-permission ${entry.id}`}
                />
              ),
              hint: entry.hint,
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
                <span className="truncate">{mode?.label}</span>
                <ChevronDown size={11} className="muted" />
              </button>
            )}
          />

          <div className="composer-actions">
            <ContextUsage onCompact={compact} />
            <button
              className="icon-btn"
              type="button"
              title="Attach images or files"
              aria-label="Attach images or files"
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
                  Queue
                </button>
                <button
                  className="btn"
                  type="button"
                  data-variant="danger"
                  onClick={stopThread}
                >
                  <Square size={11} fill="currentColor" />
                  Stop
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
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
