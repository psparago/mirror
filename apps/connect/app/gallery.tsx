import { useReflectionMedia } from '@/context/ReflectionMediaContext';
import { ensureFileUri, prepareImageForUpload } from '@/utils/mediaProcessor';
import { runMandatoryGalleryTrimIfNeededAsync } from '@/utils/mandatoryVideoTrim';
import * as ExpoImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { useNavigation, useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  PermissionsAndroid,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

const LARGE_VIDEO_WARN_BYTES = 150 * 1024 * 1024;

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
  const cancelledRef = useRef(false);
  const [statusLine, setStatusLine] = useState('Getting your library ready...');
  const [isProcessing, setIsProcessing] = useState(false);

  const confirmLargeVideoAsync = async (sizeBytes?: number | null): Promise<boolean> => {
    if (!sizeBytes || sizeBytes < LARGE_VIDEO_WARN_BYTES) return true;
    const sizeMb = Math.round(sizeBytes / (1024 * 1024));
    return await new Promise((resolve) => {
      Alert.alert(
        'Large video selected',
        `This Reflection video is about ${sizeMb} MB and may take a while to prepare. Continue?`,
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Continue', onPress: () => resolve(true) },
        ],
        { cancelable: true, onDismiss: () => resolve(false) }
      );
    });
  };

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
    cancelledRef.current = false;
    setIsProcessing(true);

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

      setStatusLine('Choose a photo or video for your Reflection...');
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
      setStatusLine(isVideo ? 'Loading selected video…' : 'Loading selected photo…');
      console.log('[GalleryScreen] media selected', {
        type: isVideo ? 'video' : 'photo',
        uri: asset.uri,
        mimeType: asset.mimeType,
        fileSize: asset.fileSize,
      });

      if (isVideo) {
        setStatusLine('Checking video details…');
        let detectedSizeBytes: number | null = typeof asset.fileSize === 'number' ? asset.fileSize : null;
        if (!detectedSizeBytes) {
          try {
            const info = await FileSystem.getInfoAsync(expoUri, { size: true });
            if (info.exists && typeof info.size === 'number') {
              detectedSizeBytes = info.size;
            }
          } catch {
            // size probe is best-effort
          }
        }
        const shouldContinue = await confirmLargeVideoAsync(detectedSizeBytes);
        if (!shouldContinue) {
          router.back();
          return;
        }
        if (detectedSizeBytes && detectedSizeBytes >= LARGE_VIDEO_WARN_BYTES) {
          setStatusLine('Large video detected. Opening trim tools…');
        } else {
          setStatusLine('Opening trim tools…');
        }
        if (cancelledRef.current) return;
        console.log('[GalleryScreen] launching mandatory trim', {
          uri: expoUri,
          detectedSizeBytes,
        });
        const trimResult = await runMandatoryGalleryTrimIfNeededAsync(expoUri);
        console.log('[GalleryScreen] mandatory trim result', trimResult);
        if (trimResult.kind === 'timeout') {
          Alert.alert(
            'Video trim timed out',
            'Preparing this Reflection video took too long. Please try a shorter clip or trim it first in Photos.'
          );
          router.back();
          return;
        }
        if (trimResult.kind === 'cancelled') {
          router.back();
          return;
        }
        if (cancelledRef.current) return;
        setStatusLine('Preparing your video for Reflection...');
        setPendingMedia({
          uri: ensureFileUri(trimResult.uri),
          type: 'video',
          source: 'gallery',
        });
      } else {
        setStatusLine('Preparing photo…');
        const optimizedUri = await prepareImageForUpload(expoUri);
        if (cancelledRef.current) return;
        setPendingMedia({
          uri: ensureFileUri(optimizedUri),
          type: 'photo',
          source: 'gallery',
        });
      }

      if (cancelledRef.current) return;
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
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color="#fff" />
      <Text style={styles.text}>{statusLine}</Text>
      {isProcessing ? (
        <TouchableOpacity
          style={styles.cancelBtn}
          onPress={() => {
            cancelledRef.current = true;
            router.back();
          }}
          activeOpacity={0.8}
        >
          <Text style={styles.cancelBtnText}>Cancel</Text>
        </TouchableOpacity>
      ) : null}
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
  cancelBtn: {
    marginTop: 18,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.55)',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  cancelBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
});
