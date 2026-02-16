import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Updates from 'expo-updates';
import { useEffect, useState } from 'react';
import { Alert } from 'react-native';

export function useOTAUpdate() {
  const [isUpdateAvailable, setIsUpdateAvailable] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [manifest, setManifest] = useState<any>(null);

  // Check for updates on mount
  useEffect(() => {
    if (__DEV__) return; 
    check();
  }, []);

  const check = async () => {
    try {
      const update = await Updates.checkForUpdateAsync();
      if (update.isAvailable) {
        setManifest(update.manifest);
        setIsUpdateAvailable(true);
      }
    } catch (e) {
      // Fail silently in the background if network is bad
      console.log('OTA Check failed:', e);
    }
  };

  const downloadAndReload = async () => {
    try {
      setIsDownloading(true);
      
      // Download the new bundle
      const result = await Updates.fetchUpdateAsync();
      
      // Fallback logic to find the label (Manifest union: only ExpoUpdatesManifest has extra)
     const m = result.manifest as { extra?: { otaLabel?: string } } | null | undefined;
     const incomingLabel = (m?.extra?.otaLabel as string | undefined) || manifest?.extra?.otaLabel || new Date().toLocaleString();

      // SAVE IT
      await AsyncStorage.setItem('last_ota_label', incomingLabel);
        
      // Restart the app to apply
      await Updates.reloadAsync();
    } catch (e) {
      setIsDownloading(false);
      Alert.alert('Update Failed', 'Could not download the update. Please try again later.');
      console.log('OTA Download failed:', e);
    }
  };

  return {
    isUpdateAvailable,
    isDownloading,
    manifest,
    downloadAndReload,
  };
}