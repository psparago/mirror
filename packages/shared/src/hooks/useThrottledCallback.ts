import { useCallback, useRef } from 'react';

const DEFAULT_LIMIT_MS = 800;

/**
 * Leading-edge throttle: runs the callback on the first invocation, then ignores
 * further calls until `limitMs` has elapsed since the last allowed execution.
 */
export function useThrottledCallback<T extends (...args: any[]) => any>(
  callback: T,
  limitMs: number = DEFAULT_LIMIT_MS
): (...args: Parameters<T>) => ReturnType<T> | undefined {
  const lastExecutedRef = useRef(0);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  return useCallback(
    (...args: Parameters<T>) => {
      const now = Date.now();
      if (now - lastExecutedRef.current > limitMs) {
        lastExecutedRef.current = now;
        return callbackRef.current(...args);
      }
      return undefined;
    },
    [limitMs]
  );
}
