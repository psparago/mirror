import FontAwesome from '@expo/vector-icons/FontAwesome';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import * as Sentry from '@sentry/react-native';
import { useFonts } from 'expo-font';
import { Stack, useRootNavigationState, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useCallback, useEffect, useRef } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';
import * as Notifications from 'expo-notifications';
import { useColorScheme } from '@/components/useColorScheme';
import { ReflectionMediaProvider } from '@/context/ReflectionMediaContext';
import { AuthProvider, ExplorerProvider, useAuth } from '@projectmirror/shared';
import { SystemUpdateModal } from '../components/SystemUpdateModel';

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  initialRouteName: 'index', // Always start at the Boot Screen
};

SplashScreen.preventAutoHideAsync();

Sentry.init({
  dsn: 'https://fd5be68ebbed311e8537030781ed02fb@o4507266632581120.ingest.us.sentry.io/4510748957409280',
  debug: false,
});

const REMINDER_SETTINGS_KEY = 'daily_reminder_settings';
const REMINDER_MIGRATION_KEY = 'daily_reminder_payload_v2_migrated';

// --- THE SESSION GUARD ---
function AuthenticatedLayout() {
  const { user, loading } = useAuth();
  const segments = useSegments() as string[];
  const router = useRouter();
  const rootNavigationState = useRootNavigationState();
  const colorScheme = useColorScheme();
  const handledNotificationIdsRef = useRef<Set<string>>(new Set());

  const routeFromNotificationData = useCallback(
    (rawData: any, notificationId?: string) => {
      if (!user) return;

      if (notificationId && handledNotificationIdsRef.current.has(notificationId)) {
        return;
      }

      // Backward/forward compatible with payloads using either "action" or "targetScreen".
      const targetScreen = rawData?.targetScreen ?? rawData?.action;
      if (!targetScreen) return;

      console.log('🔔 Notification Tapped! Target:', targetScreen);

      if (targetScreen === 'camera' || targetScreen === 'gallery' || targetScreen === 'search') {
        router.push(`/(tabs)?action=${targetScreen}` as any);
      } else {
        router.push('/(tabs)' as any);
      }

      if (notificationId) {
        handledNotificationIdsRef.current.add(notificationId);
      }
    },
    [router, user]
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

  useEffect(() => {
    // Handle cold-start tap: app launched from a notification when previously terminated.
    if (loading) return;
    if (!user) return;
    if (!rootNavigationState?.key) return;

    let isMounted = true;

    (async () => {
      try {
        const initialResponse = await Notifications.getLastNotificationResponseAsync();
        if (!isMounted || !initialResponse) return;

        const data = initialResponse.notification.request.content.data;
        const notificationId = initialResponse.notification.request.identifier;
        routeFromNotificationData(data, notificationId);
      } catch (error) {
        console.warn('Failed to read last notification response:', error);
      }
    })();

    return () => {
      isMounted = false;
    };
  }, [loading, user, rootNavigationState?.key, routeFromNotificationData]);

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
          <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
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