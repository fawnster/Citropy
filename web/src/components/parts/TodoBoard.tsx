import { motion } from "motion/react";
import type { TodoItem } from "../../../../shared/protocol.ts";

function Mark({ status }: { status: TodoItem["status"] }) {
  if (status === "completed") {
    return (
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="7" fill="var(--ok)" opacity="0.16" />
        <path d="M4.8 8.3l2.1 2.1 4.3-4.6" stroke="var(--ok)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === "in_progress") {
    return (
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="7" stroke="var(--accent)" strokeWidth="1.5" opacity="0.4" />
        <path d="M8 1a7 7 0 0 1 7 7" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round">
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 8 8"
            to="360 8 8"
            dur="1.1s"
            repeatCount="indefinite"
          />
        </path>
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.4" opacity="0.34" />
    </svg>
  );
}

export function TodoBoard({ items }: { items: TodoItem[] }) {
  if (items.length === 0) return null;
  const done = items.filter((item) => item.status === "completed").length;

  return (
    <div className="todo">
      <div className="todo-head">
        <span className="eyebrow">Plan</span>
        <span className="todo-progress">
          {done}/{items.length}
        </span>
        <span className="todo-track">
          <motion.span
            className="todo-fill"
            initial={false}
            animate={{ scaleX: items.length ? done / items.length : 0 }}
            transition={{ type: "spring", bounce: 0, duration: 0.5 }}
          />
        </span>
      </div>
      <ul className="todo-list">
        {items.map((item, index) => (
          <li key={`${index}-${item.text}`} className="todo-item" data-status={item.status}>
            <Mark status={item.status} />
            <span>{item.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
