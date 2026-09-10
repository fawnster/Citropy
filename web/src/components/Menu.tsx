import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  Fragment,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check } from "./icons.ts";

import { useApp, viewportWidth } from "../lib/store.ts";

export interface MenuItem {
  id: string;
  label: string;
  hint?: string;
  hintIcon?: ReactNode;
  icon?: ReactNode;
  selected?: boolean;
  danger?: boolean;
  section?: string;
  onSelect: () => void;
}

interface Props {
  trigger: (props: {
    open: boolean;
    toggle: () => void;
    id: string;
  }) => ReactNode;
  items: MenuItem[];
  align?: "start" | "end";
  header?: string;
  width?: number;
  searchable?: boolean;
  searchPlaceholder?: string;
}

export function Menu({
  trigger,
  items,
  align = "start",
  header,
  width = 232,
  searchable = false,
  searchPlaceholder = "Search models",
}: Props) {
  const uiScale = useApp((state) => state.uiScale);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(0);
  const id = useId();

  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const anchor = wrap.current?.getBoundingClientRect();
      if (!anchor) return;
      const scale = uiScale / 100;
      const anchorLeft = anchor.left / scale;
      const menuWidth = Math.min(width, viewportWidth() - 24);
      const preferred = align === "end" ? anchor.width / scale - menuWidth : 0;
      setLeft(
        Math.max(
          12 - anchorLeft,
          Math.min(preferred, viewportWidth() - 12 - anchorLeft - menuWidth),
        ),
      );
    };
    position();
    if (!searchable) {
      const selected = menu.current?.querySelector<HTMLButtonElement>(
        '[data-selected="true"]',
      );
      (
        selected ??
        menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')
      )?.focus();
    }
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, [open, width, align, searchable, uiScale]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const onPointer = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        document.getElementById(id)?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, id]);

  return (
    <div
      className="menu-wrap"
      ref={wrap}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      {trigger({ open, toggle: () => setOpen((value) => !value), id })}
      <AnimatePresence>
        {open && (
          <motion.div
            ref={menu}
            className="menu"
            data-align={align}
            style={{
              width,
              maxWidth: "calc(var(--viewport-width) - 24px)",
              left,
              right: "auto",
            }}
            role="menu"
            aria-labelledby={id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            onKeyDown={(event) => {
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
                return;
              if (
                event.target instanceof HTMLInputElement &&
                ["Home", "End"].includes(event.key)
              )
                return;
              const buttons = Array.from(
                menu.current?.querySelectorAll<HTMLButtonElement>(
                  '[role="menuitem"]',
                ) ?? [],
              );
              if (!buttons.length) return;
              event.preventDefault();
              const current = buttons.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? buttons.length - 1
                    : event.key === "ArrowDown"
                      ? (current + 1) % buttons.length
                      : current <= 0
                        ? buttons.length - 1
                        : current - 1;
              buttons[next]?.focus();
            }}
          >
            {header && <div className="menu-header eyebrow">{header}</div>}
            {searchable && (
              <input
                className="menu-search"
                aria-label={searchPlaceholder}
                placeholder={searchPlaceholder}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                autoFocus
              />
            )}
            <div className="menu-list scroll">
              {items
                .filter((item) =>
                  `${item.label} ${item.id} ${item.hint ?? ""}`
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                )
                .map((item, index, visibleItems) => (
                  <Fragment key={item.id}>
                    {item.section &&
                      item.section !== visibleItems[index - 1]?.section && (
                        <div className="menu-section">{item.section}</div>
                      )}
                    <button
                      key={item.id}
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      className="menu-item"
                      data-selected={item.selected || undefined}
                      data-danger={item.danger || undefined}
                      title={item.hint}
                      onClick={() => {
                        setOpen(false);
                        document.getElementById(id)?.focus();
                        item.onSelect();
                      }}
                    >
                      {item.icon && (
                        <span className="menu-icon">{item.icon}</span>
                      )}
                      <span className="menu-copy">
                        <span className="menu-label truncate">
                          {item.label}
                        </span>
                        {item.hint && (
                          <span className="menu-hint">
                            {item.hintIcon}
                            <span className="truncate">{item.hint}</span>
                          </span>
                        )}
                      </span>
                      {item.selected && (
                        <Check size={13} className="menu-check" />
                      )}
                    </button>
                  </Fragment>
                ))}
              {!items.some((item) =>
                `${item.label} ${item.id} ${item.hint ?? ""}`
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              ) && (
                <div className="menu-empty">
                  {query ? "No matches" : "No options available"}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
