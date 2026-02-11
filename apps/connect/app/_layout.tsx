import FontAwesome from '@expo/vector-icons/FontAwesome';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import * as Sentry from '@sentry/react-native';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';

import { useColorScheme } from '@/components/useColorScheme';
import { AuthProvider, ExplorerProvider, useAuth } from '@projectmirror/shared';
import { useOTAUpdate } from '../hooks/useOTAUpdate';

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  initialRouteName: 'index', 
};

SplashScreen.preventAutoHideAsync();

Sentry.init({
  dsn: 'https://fd5be68ebbed311e8537030781ed02fb@o4507266632581120.ingest.us.sentry.io/4510748957409280',
  debug: false,
});

// Wrapper to force re-mount when user changes (Critical for Auth reset)
function AuthenticatedLayout() {
  const { user } = useAuth();
  const colorScheme = useColorScheme();

  return (
    <ExplorerProvider key={user?.uid || 'guest'}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
          <Stack screenOptions={{ headerShown: false }}>
            {/* The "Boot Screen" (Traffic Cop) */}
            <Stack.Screen name="index" />
            
            {/* The Main App */}
            <Stack.Screen name="(tabs)" />
            
            {/* The "New User" Flow */}
            <Stack.Screen name="join" />
            
            {/* Auth Flow */}
            <Stack.Screen name="(auth)/login" />
          </Stack>
        </ThemeProvider>
      </GestureHandlerRootView>
    </ExplorerProvider>
  );
}

function RootLayout() {
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

  if (!loaded) return null;

  return (
    <AuthProvider>
      <AuthenticatedLayout />
    </AuthProvider>
  );
}

export default Sentry.wrap(RootLayout);