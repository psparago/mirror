import FontAwesome from '@expo/vector-icons/FontAwesome';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ThemeProvider } from '@react-navigation/native';
import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';
import { useFonts } from 'expo-font';
import { Stack, usePathname, useRootNavigationState, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { useCallback, useEffect, useRef } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';
import * as Notifications from 'expo-notifications';
import { useLastNotificationResponse } from 'expo-notifications';
import { ReflectionsNavigationTheme } from '@/constants/NavigationTheme';
import { ReflectionMediaProvider } from '@/context/ReflectionMediaContext';
import {
  bootstrapColdStartNotification,
  isBootPathname,
  parseNotificationRouteData,
  pendingRouteHasDeepLink,
  setPendingNotificationRoute,
  tabsHomeHref,
} from '@/utils/pendingNotificationRoute';
import { AuthProvider, ExplorerProvider, WaitOverlayProvider, useAuth } from '@projectmirror/shared';
import { SystemUpdateModal } from '../components/SystemUpdateModel';

// Read notification response at module-load time — before any component renders.
bootstrapColdStartNotification();

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  initialRouteName: 'index', // Always start at the Boot Screen
};

SplashScreen.preventAutoHideAsync();

const sentryDsn = (Constants.expoConfig?.extra as { sentryDsn?: string } | undefined)?.sentryDsn;
Sentry.init({
  dsn: sentryDsn,
  debug: false,
});

const REMINDER_SETTINGS_KEY = 'daily_reminder_settings';
const REMINDER_MIGRATION_KEY = 'daily_reminder_payload_v2_migrated';

// --- THE SESSION GUARD ---
function AuthenticatedLayout() {
  const { user, loading } = useAuth();
  const segments = useSegments() as string[];
  const pathname = usePathname();
  const router = useRouter();
  const rootNavigationState = useRootNavigationState();
  const handledNotificationIdsRef = useRef<Set<string>>(new Set());
  const lastNotificationResponse = useLastNotificationResponse();

  const routeFromNotificationData = useCallback(
    (rawData: Record<string, unknown> | undefined, notificationId?: string) => {
      console.log('[DeepLink] routeFromNotificationData called, user:', !!user, 'pathname:', pathname);
      const pending = parseNotificationRouteData(rawData);
      console.log('[DeepLink] parsed pending:', JSON.stringify(pending));
      if (!pendingRouteHasDeepLink(pending)) {
        console.log('[DeepLink] no deep-link fields, ignoring');
        return;
      }

      setPendingNotificationRoute(pending);

      if (!user) {
        console.log('[DeepLink] no user yet, pending stored for later');
        return;
      }

      if (notificationId && handledNotificationIdsRef.current.has(notificationId)) {
        console.log('[DeepLink] notificationId already handled, refreshing pending route');
        return;
      }

      if (!isBootPathname(pathname)) {
        console.log('[DeepLink] navigating to tabs home');
        router.replace(tabsHomeHref());
      } else {
        console.log('[DeepLink] on boot pathname, letting boot screen navigate');
      }

      if (notificationId) {
        handledNotificationIdsRef.current.add(notificationId);
      }
    },
    [pathname, router, user]
  );

  useEffect(() => {
    // This listener fires whenever a user taps a notification
    const subscription = Notifications.addNotificationResponseReceivedListener(response => {
      const data = response.notification.request.content.data;
      const notificationId = response.notification.request.identifier;
      routeFromNotificationData(data, notificationId);
    });
    return () => subscription.remove();
  }, [routeFromNotificationData]);

  useEffect(() => {
    // One-time migration: replace old scheduled reminders with payload containing targetScreen.
    if (loading) return;
    if (!user) return;
    if (!rootNavigationState?.key) return;

    let cancelled = false;

    (async () => {
      try {
        const alreadyMigrated = await AsyncStorage.getItem(REMINDER_MIGRATION_KEY);
        if (alreadyMigrated === '1') return;

        const saved = await AsyncStorage.getItem(REMINDER_SETTINGS_KEY);
        if (!saved) {
          await AsyncStorage.setItem(REMINDER_MIGRATION_KEY, '1');
          return;
        }

        const parsed = JSON.parse(saved) as {
          enabled?: boolean;
          hour?: number;
          minute?: number;
          action?: 'camera' | 'gallery' | 'none';
        };

        if (!parsed?.enabled || parsed.action === 'none') {
          await AsyncStorage.setItem(REMINDER_MIGRATION_KEY, '1');
          return;
        }

        const hour = typeof parsed.hour === 'number' ? parsed.hour : 19;
        const minute = typeof parsed.minute === 'number' ? parsed.minute : 0;
        const action = parsed.action === 'camera' || parsed.action === 'gallery' ? parsed.action : 'none';

        // Match existing scheduling behavior in settings: replace pending reminders and recreate.
        await Notifications.cancelAllScheduledNotificationsAsync();
        if (cancelled) return;

        if (action !== 'none') {
          await Notifications.scheduleNotificationAsync({
            content: {
              title: 'Send a Reflection',
              body: "It's time to send a new Reflection.",
              sound: true,
              data: {
                action,
                targetScreen: action,
              },
            },
            trigger: {
              type: Notifications.SchedulableTriggerInputTypes.CALENDAR,
              hour,
              minute,
              repeats: true,
            },
          });
        }

        await AsyncStorage.setItem(REMINDER_MIGRATION_KEY, '1');
      } catch (error) {
        console.warn('Reminder notification migration failed:', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loading, user, rootNavigationState?.key]);

  // useLastNotificationResponse covers cold-start AND is reactive — handles
  // both terminated-app taps and the case where getLastNotificationResponseAsync
  // fires after the listener is registered.
  useEffect(() => {
    if (!lastNotificationResponse) return;

    const data = lastNotificationResponse.notification.request.content.data as Record<string, unknown>;
    const notificationId = lastNotificationResponse.notification.request.identifier;
    console.log('[DeepLink] useLastNotificationResponse fired, data:', JSON.stringify(data));
    routeFromNotificationData(data, notificationId);
  }, [lastNotificationResponse, routeFromNotificationData]);

  useEffect(() => {
    // Wait for everything to be ready
    if (loading) return;
    if (!rootNavigationState?.key) return;

    // We ONLY guard the "(tabs)" group — the actual protected area.
    // Everything else (BootScreen, Login, Join) manages its own navigation.
    // This prevents race conditions where both the guard and BootScreen
    // compete with router.replace() calls simultaneously.
    const inProtectedArea = segments[0] === '(tabs)';

    if (!user && inProtectedArea) {
      router.replace('/(auth)/login');
    }
  }, [user, loading, segments, rootNavigationState?.key]);

  return (
    // The "key" prop here is a backup that forces a full remount on user change
    <ExplorerProvider key={user?.uid || 'guest'}>
      <ReflectionMediaProvider>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <WaitOverlayProvider>
            <ThemeProvider value={ReflectionsNavigationTheme}>
              <StatusBar style="light" backgroundColor={ReflectionsNavigationTheme.colors.card} />
              <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="index" />
                <Stack.Screen name="(tabs)" />
                <Stack.Screen name="join" />
                <Stack.Screen name="(auth)/login" />
                <Stack.Screen name="camera" options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }} />
                <Stack.Screen name="gallery" options={{ animation: 'none' }} />
                <Stack.Screen name="search" options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }} />
              </Stack>
            </ThemeProvider>
          </WaitOverlayProvider>
        </GestureHandlerRootView>
      </ReflectionMediaProvider>
    </ExplorerProvider>
  );
}

function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
    ...FontAwesome.font,
  });

  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded) {
      SplashScreen.hideAsync();
    }
  }, [loaded]);

  if (!loaded) return null;

  return (
    <AuthProvider>
      <AuthenticatedLayout />
      <SystemUpdateModal />
    </AuthProvider>
  );
}

export default Sentry.wrap(RootLayout);