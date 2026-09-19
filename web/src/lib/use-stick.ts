import { useCallback, useEffect, useRef, useState } from "react";

export function useStickToBottom<T extends HTMLElement, C extends HTMLElement>() {
  const viewport = useRef<T>(null);
  const content = useRef<C>(null);
  const stuck = useRef(true);
  const readingExpanded = useRef(false);
  const lastTop = useRef(0);
  const lastHeight = useRef(0);
  const [atBottom, setAtBottom] = useState(true);
  const [nearBottom, setNearBottom] = useState(true);
  const stopFollowing = useCallback(() => {
    stuck.current = false;
    readingExpanded.current = false;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const node = viewport.current;
    if (!node) return;
    stuck.current = true;
    readingExpanded.current = false;
    setAtBottom(true);
    node.scrollTo({ top: node.scrollHeight, behavior });
    lastTop.current = node.scrollTop;
  }, []);

  useEffect(() => {
    const node = viewport.current;
    const inner = content.current;
    if (!node || !inner) return;

    const onScroll = () => {
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
      const near = distance < 2;
      if (!readingExpanded.current) {
        if (near) stuck.current = true;
        else if (node.scrollTop < lastTop.current - 1 && node.scrollHeight >= lastHeight.current) stuck.current = false;
      }
      lastTop.current = node.scrollTop;
      lastHeight.current = node.scrollHeight;
      setAtBottom(near);
      setNearBottom(distance < 96);
    };

    const onWheel = (event: WheelEvent) => {
      readingExpanded.current = false;
      if (event.deltaY < 0) stuck.current = false;
    };

    const onPointerDown = () => {
      readingExpanded.current = false;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key))
        readingExpanded.current = false;
      if (["ArrowUp", "PageUp", "Home"].includes(event.key)) stuck.current = false;
    };

    const onToggle = (event: Event) => {
      if (!(event.target as Element).closest("button[aria-expanded]")) return;
      readingExpanded.current = true;
      stuck.current = false;
      node.scrollTo({ top: node.scrollTop, behavior: "instant" });
      lastTop.current = node.scrollTop;
    };

    const observer = new ResizeObserver(() => {
      if (stuck.current) node.scrollTop = node.scrollHeight;
      lastTop.current = node.scrollTop;
      lastHeight.current = node.scrollHeight;
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
      setAtBottom(distance < 2);
      setNearBottom(distance < 96);
    });

    observer.observe(inner);
    observer.observe(node);
    node.addEventListener("scroll", onScroll, { passive: true });
    node.addEventListener("wheel", onWheel, { passive: true });
    node.addEventListener("click", onToggle, true);
    node.addEventListener("pointerdown", onPointerDown, { passive: true });
    node.addEventListener("keydown", onKeyDown);
    node.scrollTop = node.scrollHeight;
    lastTop.current = node.scrollTop;
    lastHeight.current = node.scrollHeight;

    return () => {
      observer.disconnect();
      node.removeEventListener("scroll", onScroll);
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("click", onToggle, true);
      node.removeEventListener("pointerdown", onPointerDown);
      node.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return { viewport, content, atBottom, nearBottom, scrollToBottom, stopFollowing };
}
