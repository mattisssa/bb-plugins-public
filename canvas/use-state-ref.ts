import { useCallback, useRef, useState, type SetStateAction } from "react";

// Event batches and async work need the latest value before React renders.
export function useStateRef<T>(initial: T | (() => T)) {
  const [value, setValue] = useState(initial);
  const ref = useRef(value);
  const update = useCallback((next: SetStateAction<T>) => {
    const value =
      typeof next === "function"
        ? (next as (current: T) => T)(ref.current)
        : next;
    ref.current = value;
    setValue(() => value);
  }, []);
  return [value, update, ref] as const;
}
