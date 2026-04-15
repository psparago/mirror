import { deleteScratchMediaFile } from '@/utils/mediaProcessor';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NativeSyntheticEvent } from 'react-native';

export type ReflectionFilterType = 'original' | 'clarity' | 'classic' | 'warm';

export type UseReflectionFiltersArgs = {
  mediaUri: string;
  mediaType: 'photo' | 'video';
  onFilteredUriChange?: (uri: string | null) => void;
};

/**
 * Filter extract + scratch-file lifecycle for Reflection composer photos.
 */
export function useReflectionFilters({ mediaUri, mediaType, onFilteredUriChange }: UseReflectionFiltersArgs) {
  const [currentFilterType, setCurrentFilterTypeState] = useState<ReflectionFilterType>('original');
  const [extractImageEnabled, setExtractImageEnabled] = useState(false);
  const [lookExtractBusy, setLookExtractBusy] = useState(false);

  const lastFilteredExtractUriRef = useRef<string | null>(null);
  const pendingExtractResolveRef = useRef<((uri: string | null) => void) | null>(null);
  const extractTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isFilterActive = currentFilterType !== 'original';

  const pulseExtractOnce = useCallback(() => {
    setExtractImageEnabled(false);
    requestAnimationFrame(() => setExtractImageEnabled(true));
  }, []);

  const handleExtractImage = useCallback(
    (e: NativeSyntheticEvent<{ uri: string }>) => {
      const raw = e.nativeEvent?.uri;
      if (!raw) return;
      const uri = raw.startsWith('file://') ? raw : `file://${raw}`;
      void (async () => {
        if (lastFilteredExtractUriRef.current && lastFilteredExtractUriRef.current !== uri) {
          await deleteScratchMediaFile(lastFilteredExtractUriRef.current);
        }
        lastFilteredExtractUriRef.current = uri;
        onFilteredUriChange?.(uri);
        setLookExtractBusy(false);
        setExtractImageEnabled(false);
        if (extractTimeoutRef.current) {
          clearTimeout(extractTimeoutRef.current);
          extractTimeoutRef.current = null;
        }
        const r = pendingExtractResolveRef.current;
        pendingExtractResolveRef.current = null;
        r?.(uri);
      })();
    },
    [onFilteredUriChange],
  );

  const extractFilteredImage = useCallback((): Promise<string | null> => {
    if (mediaType !== 'photo' || currentFilterType === 'original') return Promise.resolve(null);
    return new Promise((resolve) => {
      setLookExtractBusy(true);
      pendingExtractResolveRef.current = resolve;
      if (extractTimeoutRef.current) clearTimeout(extractTimeoutRef.current);
      extractTimeoutRef.current = setTimeout(() => {
        extractTimeoutRef.current = null;
        if (pendingExtractResolveRef.current) {
          pendingExtractResolveRef.current(lastFilteredExtractUriRef.current);
          pendingExtractResolveRef.current = null;
        }
        setLookExtractBusy(false);
      }, 12000);
      pulseExtractOnce();
    });
  }, [mediaType, currentFilterType, pulseExtractOnce]);

  const setCurrentFilterType = useCallback(
    (next: ReflectionFilterType) => {
      setCurrentFilterTypeState(next);
      if (next === 'original') {
        setExtractImageEnabled(false);
        pendingExtractResolveRef.current?.(null);
        pendingExtractResolveRef.current = null;
        if (extractTimeoutRef.current) {
          clearTimeout(extractTimeoutRef.current);
          extractTimeoutRef.current = null;
        }
        onFilteredUriChange?.(null);
        void deleteScratchMediaFile(lastFilteredExtractUriRef.current);
        lastFilteredExtractUriRef.current = null;
      }
    },
    [onFilteredUriChange],
  );

  useEffect(() => {
    setCurrentFilterTypeState('original');
    setExtractImageEnabled(false);
    pendingExtractResolveRef.current?.(null);
    pendingExtractResolveRef.current = null;
    if (extractTimeoutRef.current) {
      clearTimeout(extractTimeoutRef.current);
      extractTimeoutRef.current = null;
    }
    onFilteredUriChange?.(null);
    void deleteScratchMediaFile(lastFilteredExtractUriRef.current);
    lastFilteredExtractUriRef.current = null;
  }, [mediaUri, mediaType, onFilteredUriChange]);

  useEffect(() => {
    if (!isFilterActive || mediaType !== 'photo') return;
    const t = setTimeout(() => pulseExtractOnce(), 450);
    return () => clearTimeout(t);
  }, [currentFilterType, mediaUri, mediaType, isFilterActive, pulseExtractOnce]);

  useEffect(
    () => () => {
      void deleteScratchMediaFile(lastFilteredExtractUriRef.current);
      lastFilteredExtractUriRef.current = null;
    },
    [],
  );

  return {
    currentFilterType,
    setCurrentFilterType,
    isFilterActive,
    extractImageEnabled,
    lookExtractBusy,
    handleExtractImage,
    extractFilteredImage,
    lastFilteredExtractUriRef,
  };
}
