import { useEffect, useState } from "react";
import { BookOpen, RefreshCw, Search, Trash2, ChevronDown } from "lucide-react";
import { api } from "../lib/api.ts";
import { confirmAction, useApp } from "../lib/store.ts";
import { ProviderIcon } from "./ProviderIcon.tsx";
import { Prose } from "./parts/Prose.tsx";
import type { SkillInfo } from "../../../shared/features.ts";

export function SkillsSettings() {
  const projects = useApp((state) => state.projects);
  const active = useApp((state) => state.activeProjectId);
  const [projectId, setProjectId] = useState(active ?? "");
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [expanded, setExpanded] = useState("");
  const [content, setContent] = useState("");
  const suffix = projectId ? `?projectId=${projectId}` : "";
  useEffect(() => {
    const controller = new AbortController();
    setBusy("loading");
    setError("");
    api<SkillInfo[]>(`skills${suffix}`, { signal: controller.signal })
      .then(setSkills)
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy("");
      });
    return () => controller.abort();
  }, [projectId, revision]);
  useEffect(() => {
    setContent("");
    if (!expanded) return;
    const controller = new AbortController();
    api<{ content: string }>(
      `skills?${new URLSearchParams({ id: expanded, ...(projectId ? { projectId } : {}) })}`,
      { signal: controller.signal },
    )
      .then((result) => setContent(result.content))
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [expanded, projectId]);
  const change = async (skill: SkillInfo, action: string) => {
    if (
      action === "delete" &&
      !(await confirmAction({
        title: `Delete ${skill.name}?`,
        context: skill.path,
        description: skill.scope === "builtin"
          ? "Remove this shared skill from all Citropy providers. Its instructions can be restored in Computer use settings."
          : "Remove this installed skill from its provider. Citropy keeps a recovery copy of its instructions in deleted-skills.",
        label: "Delete skill",
        danger: true,
      }))
    )
      return;
    setBusy(skill.id);
    setError("");
    try {
      setSkills(
        await api<SkillInfo[]>(`skills${suffix}`, {
          method: "PATCH",
          body: JSON.stringify({ id: skill.id, action }),
        }),
      );
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy("");
    }
  };
  const filtered = skills.filter(
    (skill) =>
      (!provider || skill.provider === provider) &&
      `${skill.name} ${skill.description} ${skill.path}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <div className="feature-stack">
      <div className="feature-filters">
        <label className="feature-search">
          <Search size={16} />
          <input
            aria-label="Search skills"
            placeholder="Find a skill…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <select
          aria-label="Filter skills by provider"
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
        >
          <option value="">All providers</option>
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
          <option value="opencode">OpenCode</option>
        </select>
        <button
          className="icon-btn"
          aria-label="Refresh skills"
          disabled={Boolean(busy)}
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCw size={17} />
        </button>
      </div>
      <label className="feature-field">
        Include project skills
        <select
          disabled={Boolean(busy)}
          value={projectId}
          onChange={(event) => {
            setProjectId(event.target.value);
            setExpanded("");
          }}
        >
          <option value="">Personal and plugin skills only</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <p className="feature-note">
        {filtered.filter((skill) => skill.enabled).length} enabled ·{" "}
        {filtered.length} installed. Changes apply to the installed skill,
        including its provider CLI. Finish active provider conversations before
        changing skills.
      </p>
      <details className="skills-about">
        <summary>How skills are shared</summary>
        <p>
          Personal skills are available across projects for their provider.
          Project skills belong to the selected workspace. Plugin skills come
          from installed plugins.
        </p>
        <p>
          Citropy also reads shared skills from <code>~/.agents/skills</code>{" "}
          and the workspace’s <code>.agents/skills</code>. The provider filter
          shows which providers can use each skill. Codex uses its own reported
          inventory. A shared file can affect several providers when disabled or
          deleted.
        </p>
        <p>
          Type <code>@</code> in a conversation to choose an enabled skill.
          Citropy passes its instructions or native skill reference to that
          conversation’s provider.
        </p>
      </details>
      {error && (
        <p className="feature-error" role="alert">
          {error}
        </p>
      )}
      <div className="skill-list">
        {filtered.map((skill) => (
          <article className="skill-row" key={skill.id}>
            <div className="skill-summary">
              <ProviderIcon provider={skill.provider} />
              <button
                className="skill-copy"
                type="button"
                aria-expanded={expanded === skill.id}
                onClick={() =>
                  setExpanded(expanded === skill.id ? "" : skill.id)
                }
              >
                <strong>
                  {skill.name}
                  <ChevronDown size={14} />
                </strong>
                <span>{skill.description || "No description provided."}</span>
                <small>
                  {skill.scope === "builtin" ? "Citropy · All providers" : skill.scope} · {skill.path}
                </small>
              </button>
              <input
                className="setting-switch"
                type="checkbox"
                role="switch"
                aria-label={`Enable ${skill.name} for ${skill.provider}`}
                checked={skill.enabled}
                disabled={Boolean(busy)}
                onChange={() =>
                  change(skill, skill.enabled ? "disable" : "enable")
                }
              />
              <button
                type="button"
                className="icon-btn"
                aria-label={`Delete ${skill.name} for ${skill.provider}`}
                disabled={Boolean(busy)}
                onClick={() => change(skill, "delete")}
              >
                <Trash2 size={15} />
              </button>
            </div>
            {expanded === skill.id && (
              <div className="skill-content">
                <Prose text={content || "Loading instructions…"} live={false} />
              </div>
            )}
          </article>
        ))}
      </div>
      {!filtered.length && (
        <div className="pane-empty">
          <BookOpen size={28} />
          <p>
            {busy === "loading"
              ? "Reading installed skills…"
              : query
                ? "No matching skills."
                : "No skills found in these locations."}
          </p>
        </div>
      )}
    </div>
  );
}
