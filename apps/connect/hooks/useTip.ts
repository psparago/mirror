import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getTipContent,
  hasSeenTip,
  markTipSeen,
  type TipContent,
  type TipContext,
  type TipId,
} from '@/utils/tips';

export type TipAutoShowState = 'idle' | 'checking' | 'will_show' | 'skipped' | 'done';

/**
 * Auto-shows a tip once when `enabled` becomes true, if it hasn't been dismissed.
 * `showAgain()` reopens without clearing seen state (manual tip button).
 * `hide()` closes immediately and cancels any pending auto-show (safe before navigation).
 * `autoShowState` lets callers (e.g. video pause) wait without importing tip storage helpers.
 *
 * Temporary `enabled` flickers (e.g. AI processing) do not re-trigger auto-show after the tip
 * has already been presented or resolved in this mount.
 */
export function useTip(id: TipId, enabled: boolean, ctx?: TipContext) {
  const [visible, setVisible] = useState(false);
  const [autoShowState, setAutoShowState] = useState<TipAutoShowState>('idle');
  const content: TipContent = useMemo(() => getTipContent(id, ctx), [id, ctx?.explorerName]);
  const checkedRef = useRef(false);
  const enabledRef = useRef(enabled);
  /** True once auto-show presented, skipped (already seen), or dismissed. */
  const resolvedRef = useRef(false);
  /** Bumped to invalidate in-flight hasSeenTip + delayed auto-show. */
  const showGenerationRef = useRef(0);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!enabled) {
      showGenerationRef.current += 1;
      setVisible(false);
      if (resolvedRef.current) {
        // Keep resolution across temporary disables (AI overlay / processing).
        return;
      }
      checkedRef.current = false;
      setAutoShowState('idle');
      return;
    }
    if (checkedRef.current || resolvedRef.current) return;
    checkedRef.current = true;
    const generation = ++showGenerationRef.current;
    setAutoShowState('checking');
    hasSeenTip(id).then((seen) => {
      // Re-check: Companion may have already left the screen while AsyncStorage resolved.
      if (generation !== showGenerationRef.current || !enabledRef.current) return;
      if (seen) {
        resolvedRef.current = true;
        setAutoShowState('skipped');
        return;
      }
      setAutoShowState('will_show');
      // Brief delay so a fast Back-to-Library tap after landing doesn’t race tip present vs leave.
      setTimeout(() => {
        if (generation !== showGenerationRef.current || !enabledRef.current) return;
        resolvedRef.current = true;
        setVisible(true);
        setAutoShowState('done');
      }, 450);
    });
  }, [enabled, id]);

  const hide = useCallback(() => {
    showGenerationRef.current += 1;
    setVisible(false);
    setAutoShowState((prev) => (prev === 'will_show' || prev === 'checking' ? 'done' : prev));
  }, []);

  const dismiss = useCallback(() => {
    showGenerationRef.current += 1;
    resolvedRef.current = true;
    setVisible(false);
    setAutoShowState('done');
    void markTipSeen(id);
  }, [id]);

  const showAgain = useCallback(() => {
    if (!enabledRef.current) return;
    showGenerationRef.current += 1;
    setVisible(true);
  }, []);

  return { visible, content, dismiss, hide, showAgain, autoShowState };
}
