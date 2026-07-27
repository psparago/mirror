import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getTipContent,
  hasSeenTip,
  markTipSeen,
  type TipContent,
  type TipContext,
  type TipId,
} from '@/utils/tips';

/**
 * Auto-shows a tip once when `enabled` becomes true, if it hasn't been dismissed.
 * `showAgain()` reopens without clearing seen state (manual tip button).
 */
export function useTip(id: TipId, enabled: boolean, ctx?: TipContext) {
  const [visible, setVisible] = useState(false);
  const content: TipContent = useMemo(() => getTipContent(id, ctx), [id, ctx?.explorerName]);
  const checkedRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      setVisible(false);
      checkedRef.current = false;
      return;
    }
    if (checkedRef.current) return;
    checkedRef.current = true;
    let cancelled = false;
    hasSeenTip(id).then((seen) => {
      if (!cancelled && !seen) setVisible(true);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, id]);

  const dismiss = useCallback(async () => {
    setVisible(false);
    await markTipSeen(id);
  }, [id]);

  const showAgain = useCallback(() => {
    setVisible(true);
  }, []);

  return { visible, content, dismiss, showAgain };
}
