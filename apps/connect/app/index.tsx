import { useAuth, useWaitOverlay } from '@projectmirror/shared';
import { useRelationships } from '@projectmirror/shared/hooks/useRelationships';
import {
  isBootPathname,
  parseNotificationRouteData,
  pendingRouteHasDeepLink,
  setPendingNotificationRoute,
  tabsHomeHref,
} from '@/utils/pendingNotificationRoute';
import * as Notifications from 'expo-notifications';
import { usePathname, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { FontAwesome } from '@expo/vector-icons';

export default function BootScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const waitOverlay = useWaitOverlay();
  const { user, loading: authLoading } = useAuth();
  const { relationships, loading: relLoading } = useRelationships(user?.uid);
  const hasNavigatedRef = useRef(false);

  useEffect(() => {
    if (!isBootPathname(pathname)) return;
    if (authLoading) return;
    if (hasNavigatedRef.current) return;

    if (!user) {
      hasNavigatedRef.current = true;
      router.replace('/(auth)/login');
      return;
    }

    if (relLoading) return;

    if (relationships.length === 0) {
      hasNavigatedRef.current = true;
      router.replace('/join');
      return;
    }

    hasNavigatedRef.current = true;

    (async () => {
      try {
        const initialResponse = await Notifications.getLastNotificationResponseAsync();
        console.log('[DeepLink] BootScreen getLastNotification:', initialResponse ? JSON.stringify(initialResponse.notification.request.content.data) : 'null');
        if (initialResponse) {
          const pending = parseNotificationRouteData(
            initialResponse.notification.request.content.data as Record<string, unknown>
          );
          if (pendingRouteHasDeepLink(pending)) {
            console.log('[DeepLink] BootScreen stored pending:', JSON.stringify(pending));
            setPendingNotificationRoute(pending);
          }
        }
      } catch (error) {
        console.warn('BootScreen: failed to read cold-start notification:', error);
      }

      router.replace(tabsHomeHref());
    })();
  }, [user, authLoading, relationships, relLoading, pathname, router]);

  useEffect(() => {
    if (authLoading || relLoading) {
      waitOverlay.show(
        {
          title: 'Opening Reflections Connect...',
          detail: 'Checking your account and Explorer connections.',
          icon: <FontAwesome name="users" size={20} color="#dbeafe" />,
          tone: 'sparkle',
        },
        'connect-boot-wait-overlay'
      );
      return;
    }

    waitOverlay.hide('connect-boot-wait-overlay');
  }, [authLoading, relLoading, waitOverlay]);

  useEffect(() => {
    return () => waitOverlay.hide('connect-boot-wait-overlay');
  }, [waitOverlay]);

  return (
    <View style={{ flex: 1, backgroundColor: '#121212' }} />
  );
}
