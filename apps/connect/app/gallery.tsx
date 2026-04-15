import { useReflectionMedia } from '@/context/ReflectionMediaContext';
import {
  ensureFileUri,
  prepareImageForUpload,
  prepareVideoForUpload,
} from '@/utils/mediaProcessor';
import * as ExpoImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import ImagePicker from 'react-native-image-crop-picker';
import { useNavigation, useRouter } from 'expo-router';
import React, { useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  Alert,
  PermissionsAndroid,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';

const MAX_VIDEO_DURATION_SECONDS = 60;

const PHOTO_CROP_SIZE = 1080;

/** Square stage crop (after Expo system pick / trim). */
const squarePhotoCrop = {
  width: PHOTO_CROP_SIZE,
  height: PHOTO_CROP_SIZE,
  cropping: true as const,
  avoidEmptySpaceAroundImage: true,
  freeStyleCropEnabled: true,
  enableRotationGesture: true,
  forceJpg: true,
  compressImageQuality: 0.92,
};

/** uCrop / cropper chrome (Android-focused; harmless extras on iOS). */
const reflectionCropperChrome = {
  cropperToolbarTitle: 'Edit Reflection',
  cropperActiveWidgetColor: '#2e78b7',
  cropperToolbarColor: '#1a1a1a',
  cropperToolbarWidgetColor: 'rgba(255,255,255,0.92)',
  cropperStatusBarLight: false,
  cropperNavigationBarLight: false,
};

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

/**
 * `react-native-image-crop-picker` expects a filesystem path; Expo may return `content://` on Android.
 */
async function pathForOpenCropper(uri: string): Promise<string> {
  const normalized = ensureFileUri(uri);
  if (normalized.startsWith('content://')) {
    if (!FileSystem.cacheDirectory) {
      throw new Error('cacheDirectory unavailable');
    }
    const dest = `${FileSystem.cacheDirectory}gallery_crop_in_${Date.now()}.jpg`;
    await FileSystem.copyAsync({ from: uri, to: dest });
    return dest.replace(/^file:\/\//, '');
  }
  return normalized.replace(/^file:\/\//, '');
}

export default function GalleryScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const { setPendingMedia } = useReflectionMedia();
  const hasLaunched = useRef(false);

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
        // SDK 52: use `MediaTypeOptions.All` for images + videos (same intent as legacy `['all']`).
        mediaTypes: ExpoImagePicker.MediaTypeOptions.All,
        allowsEditing: true,
        videoMaxDuration: MAX_VIDEO_DURATION_SECONDS,
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
        const compressedUri = await prepareVideoForUpload(expoUri);
        setPendingMedia({
          uri: ensureFileUri(compressedUri),
          type: 'video',
          source: 'gallery',
        });
      } else {
        const cropInPath = await pathForOpenCropper(asset.uri);
        const cropped = await ImagePicker.openCropper({
          mediaType: 'photo',
          path: cropInPath,
          ...squarePhotoCrop,
          ...reflectionCropperChrome,
        });
        const croppedUri = ensureFileUri(cropped.path);
        const optimizedUri = await prepareImageForUpload(croppedUri);
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
      <Text style={styles.text}>Opening gallery...</Text>
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
