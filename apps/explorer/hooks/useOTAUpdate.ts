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
      
      // 1. Download the new bundle
      await Updates.fetchUpdateAsync();
      
      // 2. Restart the app to apply
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