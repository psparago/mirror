import { useAuth, useWaitOverlay } from '@projectmirror/shared';
import { useRelationships } from '@projectmirror/shared/hooks/useRelationships';
import { usePathname, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { View } from 'react-native';
import { FontAwesome } from '@expo/vector-icons';

export default function BootScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const waitOverlay = useWaitOverlay();
  const { user, loading: authLoading } = useAuth();
  // We can safely fetch relationships here because we are inside the Provider
  const { relationships, loading: relLoading } = useRelationships(user?.uid);

  useEffect(() => {
    // If another route (e.g. notification deep-link) is currently active,
    // BootScreen must not override it.
    if (pathname !== '/') return;

    // Wait for Auth to initialize
    if (authLoading) return;

    // Not logged in? -> Login
    if (!user) {
      router.replace('/(auth)/login');
      return;
    }

    // Wait for Relationships to load (only if logged in)
    if (relLoading) return;

    // Logged in but no family? -> Join Screen
    if (relationships.length === 0) {
      router.replace('/join');
      return;
    }

    // Everything good? -> Home
    router.replace('/(tabs)');
    
  }, [user, authLoading, relationships, relLoading, pathname]);

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