import { useAuth, useWaitOverlay } from '@projectmirror/shared';
import { useRelationships } from '@projectmirror/shared/hooks/useRelationships';
import {
  isBootPathname,
  tabsHomeHref,
} from '@/utils/pendingNotificationRoute';
import { usePathname, useRootNavigationState, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { FontAwesome } from '@expo/vector-icons';

export default function BootScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const rootNavigationState = useRootNavigationState();
  const waitOverlay = useWaitOverlay();
  const { user, loading: authLoading } = useAuth();
  const { relationships, loading: relLoading } = useRelationships(user?.uid);
  const hasNavigatedRef = useRef(false);

  useEffect(() => {
    if (!isBootPathname(pathname)) return;
    if (authLoading) return;
    if (hasNavigatedRef.current) return;
    // Wait for the navigator to be mounted before calling router.replace().
    // On Android cold starts the navigator tree may not be ready yet, and a
    // premature replace() silently no-ops, leaving the app on the black boot
    // screen with hasNavigatedRef already set so it never retries.
    if (!rootNavigationState?.key) return;

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
    router.replace(tabsHomeHref());
  }, [user, authLoading, relationships, relLoading, pathname, router, rootNavigationState?.key]);

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
