import { useI18n } from "../lib/i18n.ts";
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
import { useReducedMotion } from "../lib/use-reduced-motion.ts";
import { Check, ChevronRight } from "./icons.ts";

import { useApp, viewportWidth } from "../lib/store.ts";

export interface MenuItem {
  id: string;
  label: string;
  hint?: string;
  hintIcon?: ReactNode;
  icon?: ReactNode;
  selected?: boolean;
  danger?: boolean;
  disabled?: boolean;
  section?: string;
  action?: { label: string; icon: ReactNode; pressed?: boolean; onSelect: () => void };
  children?: MenuItem[];
  onSelect?: () => void;
}

interface Props {
  trigger?: (props: {
    open: boolean;
    toggle: () => void;
    id: string;
  }) => ReactNode;
  items: MenuItem[];
  align?: "start" | "end";
  header?: string;
  controls?: ReactNode;
  width?: number;
  searchable?: boolean;
  searchPlaceholder?: string;
  className?: string;
  emptyMessage?: string;
  anchor?: HTMLElement;
  onClose?: () => void;
}

export function Menu({
  trigger,
  items,
  align = "start",
  header,
  controls,
  width = 232,
  searchable = false,
  searchPlaceholder = "Search models",
  className = "",
  emptyMessage,
  anchor,
  onClose,
}: Props) {
  const t = useI18n();
  const reducedMotion = useReducedMotion();
  const uiScale = useApp((state) => state.uiScale);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(Boolean(anchor));
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const wrap = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const visibleItems: (MenuItem & { depth: number })[] = [];
  const matches = (item: MenuItem, text: string): boolean =>
    `${item.label} ${item.id} ${item.hint ?? ""}`.toLowerCase().includes(text) || Boolean(item.children?.some(child => matches(child, text)));
  const collect = (entries: MenuItem[], depth: number, text: string) => {
    for (const item of entries) {
      if (!matches(item, text)) continue;
      visibleItems.push({ ...item, depth });
      if (item.children && (text || !collapsed.has(item.id))) {
        const groupMatches = `${item.label} ${item.hint ?? ""}`.toLowerCase().includes(text);
        collect(item.children, depth + 1, groupMatches ? "" : text);
      }
    }
  };
  collect(items, 0, query.toLowerCase());
  const toggleGroup = (itemId: string, collapse = !collapsed.has(itemId)) => setCollapsed(previous => {
    const next = new Set(previous);
    if (collapse) next.add(itemId); else next.delete(itemId);
    return next;
  });

  useLayoutEffect(() => {
    const element = menu.current;
    if (!open || !element) return;
    element.showPopover();
    const position = () => {
      if (anchor && !anchor.isConnected) { setOpen(false); return; }
      const bounds = (anchor ?? wrap.current)?.getBoundingClientRect();
      if (!bounds) return;
      const scale = uiScale / 100;
      const anchorLeft = bounds.left / scale;
      const menuWidth = Math.min(width, viewportWidth() - 24);
      const preferred = align === "end" ? bounds.right / scale - menuWidth : anchorLeft;
      element.style.width = `${menuWidth}px`;
      element.style.maxHeight = "";
      const height = element.offsetHeight;
      const above = Math.max(0, bounds.top / scale - 18);
      const below = Math.max(0, (innerHeight - bounds.bottom) / scale - 18);
      const upwards = height > below && above > below;
      const available = upwards ? above : below;
      element.style.maxHeight = `${available}px`;
      element.style.left = `${Math.max(12, Math.min(preferred, viewportWidth() - menuWidth - 12))}px`;
      element.style.top = `${upwards ? bounds.top / scale - Math.min(height, available) - 6 : bounds.bottom / scale + 6}px`;
    };
    position();
    if (searchable) {
      element.querySelector<HTMLInputElement>(".menu-search")?.focus({ preventScroll: true });
    } else {
      const selected = menu.current?.querySelector<HTMLButtonElement>(
        '[role="menuitem"][data-selected="true"]:not(:disabled)',
      );
      (
        selected ??
        menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      )?.focus({ preventScroll: true });
    }
    const resize = new ResizeObserver(position);
    resize.observe(element);
    const source = anchor ?? wrap.current;
    if (source) resize.observe(source);
    const removed = anchor ? new MutationObserver(() => {
      if (!anchor.isConnected) setOpen(false);
    }) : undefined;
    removed?.observe(document.body, { childList: true, subtree: true });
    const scroll = (event: Event) => {
      if (!element.contains(event.target as Node)) position();
    };
    window.addEventListener("resize", position);
    window.addEventListener("scroll", scroll, true);
    return () => {
      resize.disconnect();
      removed?.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [open, width, align, searchable, uiScale, anchor]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const onPointer = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node) && !anchor?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        (anchor ?? document.getElementById(id))?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, id, anchor]);

  useLayoutEffect(() => {
    if (open && document.activeElement === document.body)
      menu.current?.querySelector<HTMLElement>(".menu-search, .menu-item")?.focus({ preventScroll: true });
  }, [open, items]);

  return (
    <div
      className="menu-wrap"
      style={anchor ? { display: "contents" } : undefined}
      ref={wrap}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      {trigger?.({ open, toggle: () => setOpen((value) => !value), id })}
      <AnimatePresence onExitComplete={onClose}>
        {open && (
          <motion.div
            ref={menu}
            className={`menu ${className}`}
            popover="manual"
            data-align={align}
            style={{
              width,
              maxWidth: "calc(var(--viewport-width) - 24px)",
            }}
            role="menu"
            aria-labelledby={anchor ? undefined : id}
            aria-label={anchor ? header : undefined}
            initial={{ opacity: 0, scale: reducedMotion ? 1 : 0.985 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: reducedMotion ? 1 : 0.985, pointerEvents: "none" }}
            transition={{ duration: reducedMotion ? 0 : 0.16, ease: [0.16, 1, 0.3, 1] }}
            onKeyDown={(event) => {
              if (event.target instanceof HTMLSelectElement) return;
              const option = (event.target as HTMLElement).closest(".menu-option");
              const groupId = option?.getAttribute("data-group");
              if (groupId && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
                event.preventDefault();
                toggleGroup(groupId, event.key === "ArrowLeft");
                return;
              }
              if (option && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
                const target = option.querySelector<HTMLButtonElement>(event.key === "ArrowRight" ? ".menu-item-action" : ".menu-item");
                if (target) { event.preventDefault(); target.focus(); }
                return;
              }
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
                return;
              if (
                event.target instanceof HTMLInputElement &&
                ["Home", "End"].includes(event.key)
              )
                return;
              const buttons = Array.from(
                menu.current?.querySelectorAll<HTMLButtonElement>(
                  '[role="menuitem"]:not(:disabled)',
                ) ?? [],
              );
              if (!buttons.length) return;
              event.preventDefault();
              const current = buttons.indexOf(
                (option?.querySelector(".menu-item") ?? document.activeElement) as HTMLButtonElement,
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
            {controls}
            {searchable && (
              <input
                className="menu-search"
                aria-label={t(searchPlaceholder)}
                placeholder={t(searchPlaceholder)}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            )}
            <div className="menu-list scroll">
              {visibleItems.map((item, index) => (
                  <Fragment key={item.id}>
                    {item.section &&
                      item.section !== visibleItems[index - 1]?.section && (
                        <div className="menu-section">{item.section}</div>
                      )}
                    <div className="menu-option" data-selected={item.selected || undefined} data-group={item.children ? item.id : undefined}>
                      <button
                        type="button"
                        disabled={item.disabled}
                        role="menuitem"
                        tabIndex={-1}
                        className="menu-item"
                        data-selected={item.selected || undefined}
                        data-danger={item.danger || undefined}
                        data-depth={item.depth || undefined}
                        style={item.depth ? { paddingInlineStart: 10 + item.depth * 18 } : undefined}
                        aria-expanded={item.children ? Boolean(query) || !collapsed.has(item.id) : undefined}
                        title={item.hint}
                        onClick={() => {
                          if (item.children) { toggleGroup(item.id); return; }
                          setOpen(false);
                          (anchor ?? document.getElementById(id))?.focus({ preventScroll: true });
                          item.onSelect?.();
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
                        {item.children && <ChevronRight size={13} className="menu-group-chevron" data-expanded={Boolean(query) || !collapsed.has(item.id)} />}
                      </button>
                      {item.action && <button
                        type="button"
                        className="menu-item-action"
                        aria-label={item.action.label}
                        title={item.action.label}
                        aria-pressed={item.action.pressed}
                        onClick={item.action.onSelect}
                      >{item.action.icon}</button>}
                    </div>
                  </Fragment>
                ))}
              {!visibleItems.length && (
                <div className="menu-empty">
                  {query ? t("No matches") : emptyMessage ?? t("No options available")}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
