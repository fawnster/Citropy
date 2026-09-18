import { useLayoutEffect, useRef } from "react";

export function SelectionHighlight({ value, selector = '[aria-selected="true"], [aria-pressed="true"], [aria-current="page"]' }: {
  value: string | undefined;
  selector?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const previous = useRef<{ value: string | undefined; bounds: number[] } | undefined>(undefined);

  useLayoutEffect(() => {
    const pill = ref.current;
    const host = pill?.parentElement;
    if (!pill || !host) return;
    const selected = host.querySelector<HTMLElement>(selector);
    if (!selected) {
      pill.hidden = true;
      previous.current = undefined;
      return;
    }
    const position = (animate: boolean) => {
      const bounds = [selected.offsetLeft, selected.offsetTop, selected.offsetWidth, selected.offsetHeight];
      if (!bounds[2] || !bounds[3]) { pill.hidden = true; previous.current = undefined; return; }
      if (previous.current?.bounds.every((number, index) => Math.abs(number - bounds[index]!) < 0.1)) { previous.current.value = value; return; }
      pill.style.transition = animate ? "" : "none";
      pill.style.transform = `translate(${bounds[0]}px, ${bounds[1]}px)`;
      pill.style.width = `${bounds[2]}px`;
      pill.style.height = `${bounds[3]}px`;
      pill.hidden = false;
      previous.current = { value, bounds };
    };
    position(Boolean(previous.current && previous.current.value !== value));
    const resize = new ResizeObserver(() => position(false));
    resize.observe(host);
    resize.observe(selected);
    for (const child of host.children) if (child !== pill) resize.observe(child);
    return () => resize.disconnect();
  }, [value, selector]);

  return <span ref={ref} className="selection-highlight" aria-hidden="true" hidden />;
}
