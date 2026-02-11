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

import { useColorScheme } from '@/components/useColorScheme';
import { AuthProvider, ExplorerProvider, useAuth } from '@projectmirror/shared';
import { useRelationships } from '@projectmirror/shared/hooks/useRelationships';
import { JoinExplorerScreen } from '../components/JoinExplorerScreen';
import { useOTAUpdate } from '../hooks/useOTAUpdate';

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

SplashScreen.preventAutoHideAsync();

Sentry.init({
  dsn: 'https://fd5be68ebbed311e8537030781ed02fb@o4507266632581120.ingest.us.sentry.io/4510748957409280',
  debug: false,
});

function AppLayout() {
  const { user, loading: authLoading } = useAuth(); 
  const { relationships, loading: relLoading } = useRelationships(user?.uid);

  const segments = useSegments();
  const router = useRouter();
  const colorScheme = useColorScheme();
  const rootNavigationState = useRootNavigationState();

  useEffect(() => {
    // Check if nav is ready
    if (!rootNavigationState?.key) return;
    
    // Check if auth is loading
    if (authLoading) return;

    const inAuthGroup = segments[0] === '(auth)';
    
    // Wrap navigation in setTimeout to push it to the next frame
    const timer = setTimeout(() => {
      if (!user && !inAuthGroup) {
        router.replace('/(auth)/login'); 
      } else if (user && inAuthGroup) {
        router.replace('/');
      }
    }, 1);

    return () => clearTimeout(timer);
  }, [user?.uid, authLoading, segments, rootNavigationState?.key]);

  if (authLoading || (user && relLoading)) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#121212' }}>
        <ActivityIndicator size="large" color="#fff" />
      </View>
    );
  }

  if (user && relationships.length === 0) {
     return (
        <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
           <JoinExplorerScreen />
        </ThemeProvider>
     );
  }

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

function AuthenticatedLayout() {
  const { user } = useAuth();
  return (
    <ExplorerProvider key={user?.uid || 'guest'}>
      <AppLayout />
    </ExplorerProvider>
  );
}

function RootLayout() {
  // ✅ FIX: Removed useRootNavigationState from here to stop the render loop
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