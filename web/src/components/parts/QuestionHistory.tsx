import { Check, ChevronRight, MessageCircleQuestion } from "lucide-react";
import type { QuestionPart } from "../../../../shared/questions.ts";
import { useI18n } from "../../lib/i18n.ts";

export function QuestionHistory({ part }: { part: QuestionPart }) {
  const t = useI18n();
  if (part.status === "pending") return <div className="question-history-status"><MessageCircleQuestion size={14} />{t("Waiting for your answer")}</div>;
  return <details className="question-history">
    <summary><ChevronRight size={12} />{part.status === "answered" ? <Check size={14} /> : <MessageCircleQuestion size={14} />}{part.status === "answered" ? t("Answers shared") : t("Questions skipped")}</summary>
    <dl>{part.questions.map(question => <div key={question.id}><dt>{question.question}</dt><dd>{part.answers?.[question.id]?.join(", ") ?? t("Skipped")}</dd></div>)}</dl>
  </details>;
}
