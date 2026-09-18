export interface UserQuestion {
  id: string;
  header?: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiple: boolean;
  secret?: boolean;
}

export interface QuestionRequest {
  id: string;
  threadId: string;
  messageId: string;
  questions: UserQuestion[];
  createdAt: number;
}

export interface QuestionPart {
  id: string;
  kind: "question";
  questions: UserQuestion[];
  status: "pending" | "answered" | "dismissed";
  answers?: Record<string, string[]>;
}

export interface QuestionResult {
  cancelled: boolean;
  answers: Record<string, string[]>;
}

export function isQuestionTool(name: string): boolean {
  return ["question", "AskUserQuestion", "request_user_input", "ask_user", "citropy_ask_user", "mcp__citropy__ask_user"].includes(name);
}

export function normalizeQuestions(input: unknown): UserQuestion[] {
  if (!Array.isArray(input) || !input.length || input.length > 4) throw new Error("Ask between one and four questions.");
  const text = (value: unknown, max: number): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= max;
  const questions = input.map((entry, index) => {
    if (!entry || typeof entry !== "object" || !text(entry.question, 4000)) throw new Error("Each question needs readable text.");
    const id = entry.id ?? `question_${index + 1}`;
    if (!text(id, 100) || ["__proto__", "constructor", "prototype"].includes(id)) throw new Error("Choose a valid question identifier.");
    if (entry.header !== undefined && !text(entry.header, 100)) throw new Error("Use a short question heading.");
    if (entry.multiple !== undefined && typeof entry.multiple !== "boolean") throw new Error("Choose whether multiple answers are allowed.");
    const options = entry.options ?? [];
    if (!Array.isArray(options) || options.length > 12) throw new Error("Offer up to twelve choices per question.");
    const normalized = options.map(option => {
      if (!option || !text(option.label, 300) || option.description !== undefined && (typeof option.description !== "string" || option.description.length > 2000)) throw new Error("Each choice needs a label and an optional description.");
      return { label: option.label.trim(), ...(option.description ? { description: option.description } : {}) };
    });
    if (new Set(normalized.map(option => option.label)).size !== normalized.length) throw new Error("Give each choice a different label.");
    return { id, question: entry.question.trim(), ...(entry.header ? { header: entry.header } : {}), options: normalized, multiple: entry.multiple === true, ...(entry.secret === true ? { secret: true } : {}) };
  });
  if (new Set(questions.map(question => question.id)).size !== questions.length) throw new Error("Question identifiers must be unique.");
  return questions;
}
