import FontAwesome from '@expo/vector-icons/FontAwesome';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import * as Sentry from '@sentry/react-native';
import { useFonts } from 'expo-font';
import { Stack, useRootNavigationState, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';

// Import your Shared Auth
import { AuthProvider, ExplorerProvider, useAuth } from '@projectmirror/shared';

import { useColorScheme } from '@/components/useColorScheme';
import { useOTAUpdate } from '../hooks/useOTAUpdate';

// ✅ NEW IMPORTS: For the Onboarding Flow
import { useRelationships } from '@projectmirror/shared/hooks/useRelationships';
import { JoinExplorerScreen } from '../components/JoinExplorerScreen';

export {
  ErrorBoundary
} from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

SplashScreen.preventAutoHideAsync();

Sentry.init({
  dsn: 'https://fd5be68ebbed311e8537030781ed02fb@o4507266632581120.ingest.us.sentry.io/4510748957409280',
  debug: false,
});

// --- COMPONENT 1: The "Inside" Layout (Nav + Auth Logic) ---
function AppLayout() {
  const { user, loading: authLoading } = useAuth(); 
  
  // Fetch Relationships to check if we are "new"
  const { relationships, loading: relLoading } = useRelationships(user?.uid);

  const segments = useSegments();
  const router = useRouter();
  const colorScheme = useColorScheme();

  const rootNavigationState = useRootNavigationState();

  useEffect(() => {
    // If the navigation tree isn't ready yet or auth is still loading, DO NOT try to redirect.
    if (!rootNavigationState?.key || authLoading) return;

    const inAuthGroup = segments[0] === '(auth)';

    if (!user && !inAuthGroup) {
      router.replace('/(auth)/login'); 
    } else if (user && inAuthGroup) {
      router.replace('/');
    }
  }, [user, authLoading, segments, rootNavigationState?.key]);

  // We wait for BOTH Auth and Relationships to load before showing anything.
  // This prevents the Join Screen from flashing before we know if you have relationships.
  if (authLoading || (user && relLoading)) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#121212' }}>
        <ActivityIndicator size="large" color="#fff" />
      </View>
    );
  }

  // If logged in, but NO relationships, force the Join Screen.
  if (user && relationships.length === 0) {
     return (
        <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
           <JoinExplorerScreen />
        </ThemeProvider>
     );
  }

  // Standard App Flow
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <Stack>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="(auth)/login" options={{ headerShown: false }} /> 
        </Stack>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

// --- COMPONENT 2: The "Hard Reset" Wrapper ---
// This component listens to Auth. When the User ID changes (or login happens),
// it forces ExplorerProvider and AppLayout to completely destroy and recreate via the `key`.
function AuthenticatedLayout() {
  const { user } = useAuth();

  return (
    // ✅ THE FIX: The 'key' prop forces a full remount when user changes.
    // This ensures useRelationships inside AppLayout starts as { loading: true } immediately.
    <ExplorerProvider key={user?.uid || 'guest'}>
      <AppLayout />
    </ExplorerProvider>
  );
}

// --- COMPONENT 3: The Root Entry (Providers + Assets) ---
function RootLayout() {
  const rootNavigationState = useRootNavigationState();
  useOTAUpdate();

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

  if (!loaded) {
    return null;
  }

  return (
    <AuthProvider>
      <AuthenticatedLayout />
    </AuthProvider>
  );
}

export default Sentry.wrap(RootLayout);