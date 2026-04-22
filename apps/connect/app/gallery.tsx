import { useReflectionMedia } from '@/context/ReflectionMediaContext';
import { ensureFileUri, prepareImageForUpload, processVideoForUpload } from '@/utils/mediaProcessor';
import { runMandatoryGalleryTrimIfNeededAsync } from '@/utils/mandatoryVideoTrim';
import * as ExpoImagePicker from 'expo-image-picker';
import { useNavigation, useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  PermissionsAndroid,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';

async function ensureAndroidGalleryPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const api = Platform.Version;
  if (typeof api !== 'number') return true;

  if (api >= 33) {
    const images = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES
    );
    const video = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.READ_MEDIA_VIDEO
    );
    return (
      images === PermissionsAndroid.RESULTS.GRANTED &&
      video === PermissionsAndroid.RESULTS.GRANTED
    );
  }

  if (api <= 32 && api >= 23) {
    const legacy = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE
    );
    return legacy === PermissionsAndroid.RESULTS.GRANTED;
  }

  return true;
}

export default function GalleryScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const { setPendingMedia } = useReflectionMedia();
  const hasLaunched = useRef(false);
  const [statusLine, setStatusLine] = useState('Opening gallery...');

  useEffect(() => {
    if (hasLaunched.current) return;
    hasLaunched.current = true;

    const unsubscribe = (
      navigation as { addListener: (event: string, cb: () => void) => () => void }
    ).addListener('transitionEnd', () => {
      launchPicker();
    });

    const fallback = setTimeout(() => {
      launchPicker();
    }, 600);

    return () => {
      unsubscribe();
      clearTimeout(fallback);
    };
  }, []);

  const launchPicker = async () => {
    if (!hasLaunched.current) return;
    hasLaunched.current = false;

    try {
      const granted = await ensureAndroidGalleryPermissions();
      if (!granted) {
        Alert.alert(
          'Permission Required',
          'Reflections Connect needs access to your photos and videos to pick from the gallery.',
          [{ text: 'OK', onPress: () => router.back() }]
        );
        return;
      }

      const libPerm = await ExpoImagePicker.requestMediaLibraryPermissionsAsync();
      if (!libPerm.granted) {
        Alert.alert(
          'Permission Required',
          'We need access to your photo library to choose images and videos for your Reflections.',
          [{ text: 'OK', onPress: () => router.back() }]
        );
        return;
      }

      const result = await ExpoImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        allowsEditing: false,
        quality: 1,
      });

      if (result.canceled || !result.assets?.[0]) {
        router.back();
        return;
      }

      const asset = result.assets[0];
      const expoUri = ensureFileUri(asset.uri);
      const isVideo =
        asset.type === 'video' || (asset.mimeType?.startsWith('video/') ?? false);

      if (isVideo) {
        setStatusLine('Checking video…');
        const trimResult = await runMandatoryGalleryTrimIfNeededAsync(expoUri);
        if (trimResult.kind === 'cancelled') {
          router.back();
          return;
        }
        setStatusLine('Trimming & optimizing…');
        const optimizedVideoUri = await processVideoForUpload(trimResult.uri, {
          wasTrimmed: trimResult.wasTrimmed,
        });
        setPendingMedia({
          uri: ensureFileUri(optimizedVideoUri),
          type: 'video',
          source: 'gallery',
        });
      } else {
        const optimizedUri = await prepareImageForUpload(expoUri);
        setPendingMedia({
          uri: ensureFileUri(optimizedUri),
          type: 'photo',
          source: 'gallery',
        });
      }

      router.back();
    } catch (error: unknown) {
      const err = error as { code?: string; message?: string };
      if (err?.code === 'E_PICKER_CANCELLED') {
        router.back();
        return;
      }
      if (err?.code === 'E_NO_LIBRARY_PERMISSION') {
        Alert.alert('Permission Required', 'We need access to your photos to select media for your Reflections.');
        router.back();
        return;
      }
      console.error('Gallery picker error:', error);
      Alert.alert('Error', 'Failed to pick media from gallery');
      router.back();
    }
  };

  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color="#fff" />
      <Text style={styles.text}>{statusLine}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000',
  },
  text: {
    color: '#fff',
    marginTop: 16,
    fontSize: 16,
  },
});
