import { useEffect, useRef, useState, type ReactNode } from "react";
import { BookOpen, TerminalSquare } from "lucide-react";
import type { ThreadMeta } from "../../../shared/protocol.ts";
import type { ProviderCommand, SkillInfo } from "../../../shared/features.ts";
import { api } from "../lib/api.ts";
import { providerLabels } from "../lib/format.ts";

export function ComposerInput({
  value,
  onChange,
  onSubmit,
  onFiles,
  disabled,
  thread,
  commands,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onFiles: (files: File[]) => void;
  disabled: boolean;
  thread: ThreadMeta;
  commands: Array<{ id: string; label: string; hint: string; icon: ReactNode }>;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(value.length);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState<string>();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [nativeCommands, setNativeCommands] = useState<ProviderCommand[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const mention = /(?:^|\s)@([\w.:-]*)$/.exec(value.slice(0, caret));
  const slash = /^\/[\w.:-]*$/.test(value) ? value : undefined;
  const query = mention ? `@${mention[1]}` : slash;
  const mode = mention ? "skills" : slash ? "commands" : undefined;
  useEffect(() => {
    box.current?.focus();
  }, [thread.id]);
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    node.style.height = "0px";
    node.style.height = `${Math.min(node.scrollHeight, 320)}px`;
  }, [value]);
  useEffect(() => {
    if (!mode) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setSkills([]);
    setNativeCommands([]);
    const params = new URLSearchParams({
      projectId: thread.projectId,
      threadId: thread.id,
    });
    const readSkills = api<SkillInfo[]>(`skills?${params}`, {
      signal: controller.signal,
    }).then((value) => {
      if (!controller.signal.aborted) setSkills(value);
    });
    const requests =
      mode === "commands"
        ? [
            readSkills,
            api<ProviderCommand[]>(`commands?${params}`, {
              signal: controller.signal,
            }).then((value) => {
              if (!controller.signal.aborted) setNativeCommands(value);
            }),
          ]
        : [readSkills];
    void Promise.all(requests)
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [mode, thread.id, thread.provider, thread.projectId]);
  useEffect(() => {
    setSelected(0);
    setDismissed(undefined);
  }, [query]);
  const enabled = skills
    .filter((skill) => skill.enabled && skill.provider === thread.provider)
    .sort(
      (a, b) => Number(b.scope === "project") - Number(a.scope === "project"),
    )
    .filter(
      (skill, index, entries) =>
        entries.findIndex((entry) => entry.name === skill.name) === index,
    );
  const reserved = new Set([
    ...commands.map((command) => command.label.slice(1)),
    "color",
    "config",
    "clear",
    "rename",
    "__remote-workflow",
    "workflow-launch-exec",
  ]);
  const options =
    mode === "skills"
      ? enabled
          .filter((skill) =>
            skill.name
              .toLowerCase()
              .includes((mention?.[1] ?? "").toLowerCase()),
          )
          .map((skill) => ({
            id: skill.id,
            label: `@${skill.name}`,
            hint: `${skill.scope} · ${skill.description || "Use this skill"}`,
            icon: <BookOpen size={16} />,
          }))
      : [
          ...commands,
          ...nativeCommands
            .filter(
              (command) =>
                !reserved.has(command.name) &&
                !skills.some(
                  (skill) =>
                    skill.provider === thread.provider &&
                    (skill.name === command.name ||
                      skill.name === command.name.split(":").at(-1)),
                ),
            )
            .map((command) => ({
              id: `provider:${command.name}`,
              label: `/${command.name}`,
              hint: `${providerLabels[thread.provider]} · ${command.description}${command.argumentHint ? ` · ${command.argumentHint}` : ""}`,
              icon: <TerminalSquare size={16} />,
            })),
        ].filter((command) =>
          command.label.toLowerCase().startsWith((slash ?? "").toLowerCase()),
        );
  const visible = Boolean(mode && query !== dismissed);
  const index = Math.min(selected, Math.max(0, options.length - 1));
  const activeOption = options[index];
  useEffect(() => {
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [index, query]);
  const choose = (label: string) => {
    const next = mention
      ? value.slice(0, caret - (mention[1] ?? "").length - 1) +
        label +
        " " +
        value.slice(caret)
      : label + " ";
    const position = mention
      ? caret - (mention[1] ?? "").length - 1 + label.length + 1
      : next.length;
    onChange(next);
    setCaret(position);
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(position, position);
    });
  };
  return (
    <div className="composer-writing">
      {visible && (
        <div className="composer-suggestions" ref={list}>
          <div className="composer-suggestions-heading">
            {mode === "skills" ? "Skills" : "Commands"}
            <span>
              {mode === "skills"
                ? providerLabels[thread.provider]
                : "Citropy & provider"}
            </span>
          </div>
          <div
            className="composer-suggestion-list scroll"
            id="composer-suggestions"
            role="listbox"
            aria-label={mode === "skills" ? "Skills" : "Commands"}
          >
            {options.map((option, i) => (
              <button
                type="button"
                role="option"
                aria-selected={i === index}
                id={`composer-option-${i}`}
                key={option.id}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(option.label)}
              >
                {option.icon}
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.hint}</small>
                </span>
              </button>
            ))}
            {loading && <p role="status">Loading {mode}…</p>}
            {!options.length && !loading && !error && (
              <p>No matching {mode}.</p>
            )}
            {error && <p role="status">{error}</p>}
          </div>
        </div>
      )}
      <textarea
        ref={box}
        className="composer-input scroll"
        value={value}
        rows={1}
        aria-label="Message"
        aria-autocomplete="list"
        aria-controls={visible ? "composer-suggestions" : undefined}
        aria-activedescendant={
          visible && options.length ? `composer-option-${index}` : undefined
        }
        disabled={disabled}
        placeholder={
          thread.running
            ? "Queue a follow-up…"
            : "Ask a question or describe a change…"
        }
        spellCheck={false}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.items)
            .filter((item) => item.kind === "file")
            .map((item) => item.getAsFile())
            .filter((file): file is File => Boolean(file));
          if (files.length) {
            event.preventDefault();
            onFiles(files);
          }
        }}
        onChange={(event) => {
          setCaret(event.target.selectionStart);
          onChange(event.target.value);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (visible && event.key === "Escape") {
            event.preventDefault();
            setDismissed(query);
            return;
          }
          if (visible && activeOption) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setSelected(
                (index +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  options.length) %
                  options.length,
              );
              return;
            }
            if (
              event.key === "Tab" ||
              (event.key === "Enter" &&
                !event.shiftKey &&
                (mode === "skills" || activeOption.label !== value.trim()))
            ) {
              event.preventDefault();
              choose(activeOption.label);
              return;
            }
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
    </div>
  );
}
