import * as Sentry from '@sentry/react-native';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useOTAUpdate } from '../hooks/useOTAUpdate';

Sentry.init({
  dsn: 'https://5510fbc509b29cd3d26ed552dc09ed83@o4507266632581120.ingest.us.sentry.io/4510748953870336',
  debug: false,
});

// 1. Force the splash screen to die immediately upon JS execution
SplashScreen.hideAsync().catch(() => { });

function RootLayout() {

  useOTAUpdate();
  return (
    <Stack>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="modal" options={{ presentation: 'modal' }} />
    </Stack>
  );
}

export default Sentry.wrap(RootLayout);