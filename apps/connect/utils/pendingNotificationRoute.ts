// Single source of truth for deep-link routing from push notifications.
//
// Each push tap (cold start, background tap, foreground tap) becomes a
// PendingNotificationRoute entry keyed by the Expo notification identifier.
// The pipeline guarantees:
//   1. We only ever present a given notification id once.
//   2. Listeners are only fired when the head of the queue actually changes.
//   3. There is no callback-rebuild churn — consumers read via subscribe/getSnapshot.

export type PendingNotificationRoute = {
  /** Stable id from the Expo notification (response identifier). */
  id: string;
  reflectionId?: string;
  explorerId?: string;
  action?: 'camera' | 'gallery' | 'search';
  openCreationModal?: boolean;
  /** Open ReactionSheet on the parent Reflection instead of ReplayModal. */
  openReactionComposer?: boolean;
  notificationType?: string;
};

const REACTION_COMPOSER_NOTIFICATION_TYPES = new Set([
  'companion_upload_digest',
  'companion_reaction_digest',
]);

export function shouldOpenReactionComposerForNotificationType(
  notificationType?: string
): boolean {
  if (!notificationType) return false;
  return REACTION_COMPOSER_NOTIFICATION_TYPES.has(notificationType);
}

let pendingRoute: PendingNotificationRoute | null = null;
const seenIds = new Set<string>();
const presentedIds = new Set<string>();
const listeners = new Set<() => void>();

/** Has the given notification id already been handed to a consumer? */
export function isNotificationPresented(id: string): boolean {
  return presentedIds.has(id);
}

/** Mark a notification id as "handed off to the timeline". Persists across remounts. */
export function markNotificationPresented(id: string): void {
  presentedIds.add(id);
}

function notify(): void {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      console.warn('[DeepLink] listener failed:', error);
    }
  });
}

function stringField(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

export function isBootPathname(pathname: string): boolean {
  return pathname === '/' || pathname === '/index' || pathname === '';
}

function booleanField(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
  }
  return false;
}

function deepLinkFieldsFromRawData(
  rawData: Record<string, unknown> | undefined
): {
  reflectionId?: string;
  explorerId?: string;
  action?: 'camera' | 'gallery' | 'search';
  openCreationModal?: boolean;
  openReactionComposer?: boolean;
  notificationType?: string;
} {
  if (!rawData || typeof rawData !== 'object') return {};

  const nested = rawData.data;
  const source =
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : rawData;

  const reflectionId = stringField(
    source.reflectionId ?? source.reflection_id ?? rawData.reflectionId ?? rawData.reflection_id
  );
  const explorerId = stringField(
    source.explorerId ?? source.explorer_id ?? rawData.explorerId ?? rawData.explorer_id
  );
  const targetScreen = source.targetScreen ?? source.action ?? rawData.targetScreen ?? rawData.action;
  const action =
    targetScreen === 'camera' || targetScreen === 'gallery' || targetScreen === 'search'
      ? (targetScreen as 'camera' | 'gallery' | 'search')
      : undefined;
  const notificationType = stringField(
    source.notificationType ?? source.notification_type ?? rawData.notificationType ?? rawData.notification_type
  );
  const openCreationModal =
    booleanField(source.openCreationModal ?? source.open_creation_modal ?? rawData.openCreationModal ?? rawData.open_creation_modal) ||
    notificationType === 'posting_reminder';
  const openReactionComposer =
    booleanField(
      source.openReactionComposer ??
        source.open_reaction_composer ??
        rawData.openReactionComposer ??
        rawData.open_reaction_composer
    ) || shouldOpenReactionComposerForNotificationType(notificationType);

  return {
    ...(reflectionId ? { reflectionId } : {}),
    ...(explorerId ? { explorerId } : {}),
    ...(action ? { action } : {}),
    ...(openCreationModal ? { openCreationModal: true } : {}),
    ...(openReactionComposer ? { openReactionComposer: true } : {}),
    ...(notificationType ? { notificationType } : {}),
  };
}

export function buildPendingNotificationRoute(
  notificationId: string,
  rawData: Record<string, unknown> | undefined
): PendingNotificationRoute | null {
  const fields = deepLinkFieldsFromRawData(rawData);
  if (!fields.reflectionId && !fields.explorerId && !fields.action && !fields.openCreationModal) {
    return null;
  }
  return { id: notificationId, ...fields };
}

/**
 * Submit a notification to the queue. Returns `true` if it became the head
 * (i.e. it's new and we'll present it). Already-seen ids are dropped.
 */
export function submitPendingNotificationRoute(
  route: PendingNotificationRoute | null
): boolean {
  if (!route) return false;
  if (seenIds.has(route.id)) return false;
  seenIds.add(route.id);
  pendingRoute = route;
  notify();
  return true;
}

/** Marks the head route consumed and clears it. */
export function consumePendingNotificationRoute(): PendingNotificationRoute | null {
  const route = pendingRoute;
  if (!route) return null;
  pendingRoute = null;
  notify();
  return route;
}

export function peekPendingNotificationRoute(): PendingNotificationRoute | null {
  return pendingRoute;
}

export function subscribePendingNotificationRoute(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Pin to the Reflections tab (index) where the deep-link consumer mounts. */
export function tabsHomeHref(): '/(tabs)/' {
  return '/(tabs)/';
}

// Cold-start read happens once at module load — before any component renders.
let _coldStartChecked = false;

function notificationsAvailableOnPlatform(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Platform } = require('react-native') as typeof import('react-native');
    return Platform.OS === 'ios' || Platform.OS === 'android';
  } catch {
    return false;
  }
}

export function bootstrapColdStartNotification(): void {
  if (_coldStartChecked) return;
  _coldStartChecked = true;
  if (!notificationsAvailableOnPlatform()) return;

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Notifications = require('expo-notifications') as typeof import('expo-notifications');
    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (!response) return;
        const notificationId = response.notification.request.identifier;
        const data = response.notification.request.content.data as Record<string, unknown>;
        const route = buildPendingNotificationRoute(notificationId, data);
        if (route) {
          console.log('[DeepLink] cold-start route:', JSON.stringify(route));
          submitPendingNotificationRoute(route);
        }
      })
      .catch((err) => {
        console.warn('[DeepLink] cold-start read failed:', err);
      });
  } catch (err) {
    console.warn('[DeepLink] cold-start import error:', err);
  }
}
