import { ExplorerConfig, useAuth, useExplorer } from '@projectmirror/shared';
import { db, doc, getDoc } from '@projectmirror/shared/firebase';
import { useRelationships } from '@projectmirror/shared/src/hooks/useRelationships';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import {
  consumePendingNotificationRoute,
  isNotificationPresented,
  markNotificationPresented,
  peekPendingNotificationRoute,
  subscribePendingNotificationRoute,
} from '@/utils/pendingNotificationRoute';

type DeepLinkTarget = {
  notificationId: string;
  reflectionId?: string;
  explorerId?: string;
  action?: 'camera' | 'gallery' | 'search';
  openCreationModal?: boolean;
  openReactionComposer?: boolean;
};

// Module-level state — survives across remounts of the consuming component so
// that a re-mount during cold-start (which we observe in the dev build) does
// not re-resolve the same notification and re-open the ReplayModal multiple
// times.
let moduleResolvingId: string | null = null;
let moduleLastTarget: DeepLinkTarget | null = null;
let moduleOpenCreationModal = false;
let moduleCreationAction: 'camera' | 'gallery' | 'search' | null = null;

/**
 * Consumes the head of the pending-notification-route queue and exposes the
 * data needed to deep-link into the timeline. Guarantees that each notification
 * id is presented exactly once, even if the consuming component remounts.
 */
export function useNotificationDeepLink() {
  const pendingRoute = useSyncExternalStore(
    subscribePendingNotificationRoute,
    peekPendingNotificationRoute,
    peekPendingNotificationRoute
  );

  const { user } = useAuth();
  const { switchExplorer, currentExplorerId, loading: explorerLoading } = useExplorer();
  const { loading: relLoading } = useRelationships(user?.uid);

  const [target, setTarget] = useState<DeepLinkTarget | null>(() => moduleLastTarget);
  const [timelineRefreshNonce, setTimelineRefreshNonce] = useState(0);
  const [deepLinkOpenCreationModal, setDeepLinkOpenCreationModal] = useState(
    () => moduleOpenCreationModal
  );
  const [deepLinkAction, setDeepLinkAction] = useState<'camera' | 'gallery' | 'search' | null>(
    () => moduleCreationAction
  );

  // Stable refs for context values used inside the async resolver.
  const switchExplorerRef = useRef(switchExplorer);
  switchExplorerRef.current = switchExplorer;
  const currentExplorerIdRef = useRef(currentExplorerId);
  currentExplorerIdRef.current = currentExplorerId;

  useEffect(() => {
    if (!pendingRoute) return;
    if (explorerLoading || relLoading) return;

    const { id } = pendingRoute;

    // Already handed off (possibly to a previous mount of this component).
    if (isNotificationPresented(id)) {
      if (!target && moduleLastTarget && moduleLastTarget.notificationId === id) {
        setTarget(moduleLastTarget);
      }
      return;
    }

    if (moduleResolvingId === id) return;
    moduleResolvingId = id;

    let cancelled = false;

    (async () => {
      let targetExplorerId = pendingRoute.explorerId ?? '';

      if (pendingRoute.reflectionId && !targetExplorerId) {
        try {
          const snap = await getDoc(
            doc(db, ExplorerConfig.collections.reflections, pendingRoute.reflectionId)
          );
          const resolved = snap.data()?.explorerId;
          if (typeof resolved === 'string' && resolved.trim()) {
            targetExplorerId = resolved.trim();
          }
        } catch (error) {
          console.warn('[DeepLink] failed to resolve explorer for reflection:', error);
        }
      }

      if (cancelled) return;

      if (targetExplorerId && currentExplorerIdRef.current !== targetExplorerId) {
        switchExplorerRef.current(targetExplorerId);
      }

      if (pendingRoute.reflectionId) {
        const nextTarget: DeepLinkTarget = {
          notificationId: id,
          reflectionId: pendingRoute.reflectionId,
          explorerId: targetExplorerId || undefined,
          openReactionComposer: Boolean(pendingRoute.openReactionComposer),
        };
        moduleLastTarget = nextTarget;
        markNotificationPresented(id);
        moduleResolvingId = null;
        setTarget(nextTarget);
        // Hand off to timeline immediately so peekPendingNotificationRoute() does
        // not stay populated for the whole modal session (Android tab jank).
        consumePendingNotificationRoute();
        return;
      }

      if (pendingRoute.openCreationModal || pendingRoute.action) {
        moduleLastTarget = null;
        moduleOpenCreationModal = Boolean(pendingRoute.openCreationModal || pendingRoute.action);
        moduleCreationAction = pendingRoute.action ?? null;
        markNotificationPresented(id);
        moduleResolvingId = null;
        setTarget(null);
        setDeepLinkOpenCreationModal(moduleOpenCreationModal);
        setDeepLinkAction(moduleCreationAction);
        if (targetExplorerId) {
          setTimelineRefreshNonce((value) => value + 1);
        }
        consumePendingNotificationRoute();
        return;
      }

      // Explorer-only deep link — refresh the timeline and mark complete.
      if (targetExplorerId) {
        setTimelineRefreshNonce((value) => value + 1);
      }
      markNotificationPresented(id);
      moduleResolvingId = null;
      consumePendingNotificationRoute();
    })();

    return () => {
      cancelled = true;
      if (moduleResolvingId === id) {
        moduleResolvingId = null;
      }
    };
    // `target` is intentionally excluded — adding it would trigger a re-run
    // every time we set the target, defeating the dedupe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRoute, explorerLoading, relLoading]);

  // The timeline calls this once the user closes the ReplayModal.
  const completeDeepLink = useRef(() => {
    const current = peekPendingNotificationRoute();
    if (current) {
      consumePendingNotificationRoute();
    }
    moduleLastTarget = null;
    moduleResolvingId = null;
    moduleOpenCreationModal = false;
    moduleCreationAction = null;
    setTarget(null);
    setDeepLinkOpenCreationModal(false);
    setDeepLinkAction(null);
  }).current;

  return {
    deepLinkReflectionId: target?.reflectionId ?? null,
    deepLinkExplorerId: target?.explorerId ?? null,
    deepLinkOpenReactionComposer: target?.openReactionComposer ?? false,
    timelineRefreshNonce,
    deepLinkOpenCreationModal,
    deepLinkAction,
    completeDeepLink,
  };
}
