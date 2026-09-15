import { useI18n } from "../lib/i18n.ts";
import {
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type FormEvent,
} from "react";
import { X } from "lucide-react";
import { motion, useIsPresent } from "motion/react";
import { useReducedMotion } from "../lib/use-reduced-motion.ts";

export function Modal({
  title,
  description,
  icon,
  actions,
  children,
  footer,
  busy = false,
  danger = false,
  className = "",
  initialFocus = "[data-cancel]",
  returnFocus,
  onClose,
  onSubmit,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  footer: ReactNode;
  busy?: boolean;
  danger?: boolean;
  className?: string;
  initialFocus?: string;
  returnFocus?: HTMLElement | null;
  onClose: () => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const t = useI18n();
  const present = useIsPresent();
  const reducedMotion = useReducedMotion();
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (!present) return;
    const previous = returnFocus ?? document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>(initialFocus)?.focus();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected && !document.querySelector("dialog[open]"))
        previous.focus();
    };
  }, [present]);
  return (
    <motion.dialog
      ref={ref}
      role="dialog"
      className={`citropy-dialog ${className}`}
      inert={!present}
      data-exiting={!present || undefined}
      initial={{ opacity: 0, y: reducedMotion ? 0 : 8, scale: reducedMotion ? 1 : 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: reducedMotion ? 0 : 8, scale: reducedMotion ? 1 : 0.985 }}
      transition={{ duration: reducedMotion ? 0 : 0.16, ease: [0.16, 1, 0.3, 1] }}
      aria-labelledby={`${id}-title`}
      aria-describedby={description ? `${id}-description` : undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit?.(event);
        }}
      >
        <header className="dialog-heading">
          {icon && (
            <span className="dialog-symbol" data-danger={danger}>
              {icon}
            </span>
          )}
          <div>
            <h2 id={`${id}-title`}>{title}</h2>
            {description && <p id={`${id}-description`}>{description}</p>}
          </div>
          {actions}
          <button
            className="icon-btn"
            type="button"
            aria-label={t("Close dialog")}
            disabled={busy}
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>
        {children && <div className="dialog-content">{children}</div>}
        <footer className="dialog-footer">{footer}</footer>
      </form>
    </motion.dialog>
  );
}
