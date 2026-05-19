import { ExplorerConfig, useAuth, useExplorer } from '@projectmirror/shared';
import { db, doc, getDoc } from '@projectmirror/shared/firebase';
import { useRelationships } from '@projectmirror/shared/src/hooks/useRelationships';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  consumePendingNotificationRoute,
  mergePendingRoute,
  peekPendingNotificationRoute,
  subscribePendingNotificationRoute,
} from '@/utils/pendingNotificationRoute';

function paramString(value: string | string[] | undefined): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0].trim();
  return '';
}

export function useNotificationDeepLink() {
  const params = useLocalSearchParams<{ reflectionId?: string; explorerId?: string }>();
  const { user } = useAuth();
  const { switchExplorer, currentExplorerId, loading: explorerLoading } = useExplorer();
  const { loading: relLoading } = useRelationships(user?.uid);

  const [deepLinkTarget, setDeepLinkTarget] = useState<{
    reflectionId: string;
    explorerId?: string;
  } | null>(null);
  const [timelineRefreshNonce, setTimelineRefreshNonce] = useState(0);

  const deepLinkInFlightRef = useRef(false);
  const pendingExplorerIdRef = useRef<string | null>(null);

  const completeDeepLink = useCallback(() => {
    consumePendingNotificationRoute();
    setDeepLinkTarget(null);
    pendingExplorerIdRef.current = null;
    deepLinkInFlightRef.current = false;
  }, []);

  const applyPendingRoute = useCallback(async () => {
    if (explorerLoading || relLoading) return;
    if (deepLinkInFlightRef.current) return;

    const merged = mergePendingRoute(
      paramString(params.reflectionId),
      paramString(params.explorerId)
    );
    const pending = merged ?? peekPendingNotificationRoute();
    const reflectionId = pending?.reflectionId ?? '';
    const explorerId = pending?.explorerId ?? '';

    if (!reflectionId && !explorerId) return;

    deepLinkInFlightRef.current = true;

    let targetExplorerId = explorerId;
    if (reflectionId && !targetExplorerId) {
      try {
        const snap = await getDoc(doc(db, ExplorerConfig.collections.reflections, reflectionId));
        const resolved = snap.data()?.explorerId;
        if (typeof resolved === 'string' && resolved.trim()) {
          targetExplorerId = resolved.trim();
        }
      } catch (error) {
        console.warn('[DeepLink] failed to resolve explorer for reflection:', error);
      }
    }

    if (targetExplorerId) {
      pendingExplorerIdRef.current = targetExplorerId;
      switchExplorer(targetExplorerId);
    }

    if (reflectionId) {
      setDeepLinkTarget({ reflectionId, explorerId: targetExplorerId || undefined });
      return;
    }

    if (!targetExplorerId) {
      deepLinkInFlightRef.current = false;
      return;
    }

    if (currentExplorerId === targetExplorerId) {
      setTimelineRefreshNonce((value) => value + 1);
      completeDeepLink();
    }
  }, [
    completeDeepLink,
    currentExplorerId,
    explorerLoading,
    params.explorerId,
    params.reflectionId,
    relLoading,
    switchExplorer,
  ]);

  useEffect(() => {
    void applyPendingRoute();
  }, [applyPendingRoute]);

  useEffect(() => {
    return subscribePendingNotificationRoute(() => {
      deepLinkInFlightRef.current = false;
      void applyPendingRoute();
    });
  }, [applyPendingRoute]);

  useEffect(() => {
    const targetExplorerId = pendingExplorerIdRef.current;
    if (!targetExplorerId || explorerLoading || relLoading) return;
    if (currentExplorerId !== targetExplorerId) {
      switchExplorer(targetExplorerId);
      return;
    }
    if (!deepLinkTarget && deepLinkInFlightRef.current) {
      setTimelineRefreshNonce((value) => value + 1);
      completeDeepLink();
    }
  }, [completeDeepLink, currentExplorerId, deepLinkTarget, explorerLoading, relLoading, switchExplorer]);

  return {
    deepLinkReflectionId: deepLinkTarget?.reflectionId ?? null,
    deepLinkExplorerId: deepLinkTarget?.explorerId ?? null,
    timelineRefreshNonce,
    completeDeepLink,
  };
}
