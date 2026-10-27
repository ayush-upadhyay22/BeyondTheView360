import { useEffect, useRef } from 'react';

/**
 * Calls `save(value)` once `value` has been stable for `delay` ms and differs from `saved`.
 * Pending saves are flushed on unmount so nothing typed is lost when navigating away.
 */
export function useDebouncedSave<T>(value: T, saved: T, save: (v: T) => void, delay = 600) {
  const latest = useRef({ value, saved, save });
  latest.current = { value, saved, save };

  useEffect(() => {
    if (Object.is(value, saved)) return;
    const t = setTimeout(() => latest.current.save(value), delay);
    return () => clearTimeout(t);
  }, [value, saved, delay]);

  useEffect(
    () => () => {
      const { value: v, saved: s, save: fn } = latest.current;
      if (!Object.is(v, s)) fn(v);
    },
    [],
  );
}
