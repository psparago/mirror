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
import { Platform } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';
import * as Notifications from 'expo-notifications';
import { useLastNotificationResponse } from 'expo-notifications';
import { ReflectionsNavigationTheme } from '@/constants/NavigationTheme';
import { ReflectionMediaProvider } from '@/context/ReflectionMediaContext';
import {
  bootstrapColdStartNotification,
  buildPendingNotificationRoute,
  isBootPathname,
  submitPendingNotificationRoute,
  tabsHomeHref,
} from '@/utils/pendingNotificationRoute';
import { AuthProvider, ExplorerProvider, WaitOverlayProvider, useAuth } from '@projectmirror/shared';
import { SystemUpdateModal } from '../components/SystemUpdateModel';
import { bootstrapDiagnostics } from '@/utils/diagnosticsLog';

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

const notificationsSupported = Platform.OS === 'ios' || Platform.OS === 'android';

// --- THE SESSION GUARD ---
function AuthenticatedLayout() {
  const { user, loading } = useAuth();
  const segments = useSegments() as string[];
  const pathname = usePathname();
  const router = useRouter();
  const rootNavigationState = useRootNavigationState();
  const lastNotificationResponse = useLastNotificationResponse();

  // Use refs so the response handler identity is stable. Re-running it on
  // every navigation was previously causing the deep-link pipeline to fire
  // multiple times per notification.
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const userRef = useRef(user);
  userRef.current = user;
  const routerRef = useRef(router);
  routerRef.current = router;

  const handleNotificationResponse = useCallback(
    (notificationId: string, rawData: Record<string, unknown> | undefined) => {
      const route = buildPendingNotificationRoute(notificationId, rawData);
      if (!route) return;

      // submit is idempotent per notification id; subsequent calls are ignored.
      const submitted = submitPendingNotificationRoute(route);
      if (!submitted) return;

      console.log('[DeepLink] submitted notification', notificationId, JSON.stringify(route));

      // If we're already on a tabs path, nudge navigation back to the tabs root
      // so the deep-link consumer (inside the tabs layout) sees the route.
      if (!userRef.current) return; // wait for auth; consumer will pick it up on login
      if (isBootPathname(pathnameRef.current)) return; // boot screen handles it
      routerRef.current.replace(tabsHomeHref());
    },
    []
  );

  useEffect(() => {
    if (!notificationsSupported) return;
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      handleNotificationResponse(
        response.notification.request.identifier,
        response.notification.request.content.data as Record<string, unknown>
      );
    });
    return () => subscription.remove();
  }, [handleNotificationResponse]);

  useEffect(() => {
    // One-time migration: replace old scheduled reminders with payload containing targetScreen.
    if (loading) return;
    if (!user) return;
    if (!rootNavigationState?.key) return;

    let cancelled = false;

    (async () => {
      try {
        if (!notificationsSupported) return;
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

  // useLastNotificationResponse covers cold-start AND background taps. It fires
  // once when the response becomes available. We dedupe by notification id
  // inside submitPendingNotificationRoute so additional firings are no-ops.
  useEffect(() => {
    if (!notificationsSupported) return;
    if (!lastNotificationResponse) return;
    handleNotificationResponse(
      lastNotificationResponse.notification.request.identifier,
      lastNotificationResponse.notification.request.content.data as Record<string, unknown>
    );
  }, [lastNotificationResponse, handleNotificationResponse]);

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
    void bootstrapDiagnostics();
  }, []);

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