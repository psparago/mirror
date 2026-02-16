import FontAwesome from '@expo/vector-icons/FontAwesome';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import * as Sentry from '@sentry/react-native';
import { useFonts } from 'expo-font';
import { Stack, useRootNavigationState, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';

import { useColorScheme } from '@/components/useColorScheme';
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

// --- THE SESSION GUARD ---
function AuthenticatedLayout() {
  const { user, loading } = useAuth();
  const segments = useSegments() as string[];
  const router = useRouter();
  const rootNavigationState = useRootNavigationState();
  const colorScheme = useColorScheme();

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
      <GestureHandlerRootView style={{ flex: 1 }}>
        <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="index" /> 
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="join" />
            <Stack.Screen name="(auth)/login" />
          </Stack>
        </ThemeProvider>
      </GestureHandlerRootView>
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