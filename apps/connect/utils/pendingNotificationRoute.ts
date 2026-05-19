export type PendingNotificationRoute = {
  reflectionId?: string;
  explorerId?: string;
  action?: 'camera' | 'gallery' | 'search';
};

let pendingRoute: PendingNotificationRoute | null = null;
const listeners = new Set<() => void>();

// Read the notification response at the earliest possible moment — before any component renders.
// We import expo-notifications lazily to avoid circular init issues.
let _coldStartChecked = false;
export function bootstrapColdStartNotification(): void {
  if (_coldStartChecked) return;
  _coldStartChecked = true;

  // Dynamic require so this file stays importable in server-side / test envs.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Notifications = require('expo-notifications') as typeof import('expo-notifications');
    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (!response) {
          console.log('[DeepLink] cold-start: no last notification response');
          return;
        }
        const data = response.notification.request.content.data as Record<string, unknown>;
        console.log('[DeepLink] cold-start raw data:', JSON.stringify(data));
        const pending = parseNotificationRouteData(data);
        console.log('[DeepLink] cold-start parsed pending:', JSON.stringify(pending));
        if (pendingRouteHasDeepLink(pending)) {
          console.log('[DeepLink] cold-start: stored pending route');
          setPendingNotificationRoute(pending);
        } else {
          console.log('[DeepLink] cold-start: payload has no deep-link fields');
        }
      })
      .catch((err) => {
        console.warn('[DeepLink] cold-start read failed:', err);
      });
  } catch (err) {
    console.warn('[DeepLink] bootstrapColdStartNotification import error:', err);
  }
}

function notifyPendingListeners(): void {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      console.warn('pendingNotificationRoute listener failed:', error);
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

export function parseNotificationRouteData(
  rawData: Record<string, unknown> | undefined
): PendingNotificationRoute {
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
      ? targetScreen
      : undefined;

  return {
    ...(reflectionId ? { reflectionId } : {}),
    ...(explorerId ? { explorerId } : {}),
    ...(action ? { action } : {}),
  };
}

export function setPendingNotificationRoute(route: PendingNotificationRoute | null): void {
  pendingRoute = route;
  notifyPendingListeners();
}

export function consumePendingNotificationRoute(): PendingNotificationRoute | null {
  const route = pendingRoute;
  pendingRoute = null;
  return route;
}

export function peekPendingNotificationRoute(): PendingNotificationRoute | null {
  return pendingRoute;
}

export function subscribePendingNotificationRoute(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Navigate to the Reflections timeline tab; deep-link payload is applied from pending state in (tabs)/index. */
export function tabsTimelineHref(): '/(tabs)' {
  return '/(tabs)';
}

export function tabsHomeHref(): '/(tabs)' {
  return tabsTimelineHref();
}

export function pendingRouteHasDeepLink(pending: PendingNotificationRoute | null | undefined): boolean {
  if (!pending) return false;
  return !!(pending.reflectionId || pending.explorerId || pending.action);
}

export function mergePendingRoute(
  reflectionId?: string,
  explorerId?: string
): PendingNotificationRoute | null {
  const pending = peekPendingNotificationRoute();
  const merged: PendingNotificationRoute = {
    ...(pending ?? {}),
    ...(reflectionId ? { reflectionId } : {}),
    ...(explorerId ? { explorerId } : {}),
  };
  return pendingRouteHasDeepLink(merged) ? merged : null;
}
