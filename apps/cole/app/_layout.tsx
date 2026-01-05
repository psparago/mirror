import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';

// 1. Force the splash screen to die immediately upon JS execution
SplashScreen.hideAsync().catch(() => {});

export default function RootLayout() {
  
  return (
    <Stack>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="modal" options={{ presentation: 'modal' }} />
    </Stack>
  );
}