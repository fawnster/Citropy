import { useCallback, useState, type SetStateAction } from "react";
import { useApp } from "./store.ts";

export function useDisclosure(
  id: string | undefined,
  kind: string,
  initial = false,
) {
  const [local, setLocal] = useState(initial);
  const open = useApp((state) =>
    id ? (state.disclosures[id]?.[kind] ?? local) : local,
  );
  const setOpen = useCallback(
    (value: SetStateAction<boolean>) => {
      if (!id) {
        setLocal(value);
        return;
      }
      useApp.setState((state) => {
        const previous = state.disclosures[id] ?? {};
        return {
          disclosures: {
            ...state.disclosures,
            [id]: {
              ...previous,
              [kind]:
                typeof value === "function"
                  ? value(previous[kind] ?? local)
                  : value,
            },
          },
        };
      });
    },
    [id, kind, local],
  );
  return [open, setOpen] as const;
}
