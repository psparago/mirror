import { useReflectionMedia } from '@/context/ReflectionMediaContext';
import { prepareImageForUpload, prepareVideoForUpload } from '@/utils/mediaProcessor';
import { useNavigation, useRouter } from 'expo-router';
import React, { useEffect, useRef } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';
import ImageCropPicker from 'react-native-image-crop-picker';

const MAX_VIDEO_DURATION_SECONDS = 60;
const MAX_VIDEO_DURATION_MS = MAX_VIDEO_DURATION_SECONDS * 1000;

function toFileUri(path: string): string {
  if (!path) return path;
  return path.startsWith('file://') ? path : `file://${path}`;
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
      const asset = await ImageCropPicker.openPicker({
        width: 1080,
        height: 1080,
        cropping: true,
        mediaType: 'any',
        enableRotationGesture: true,
        forceJpg: true,
        compressImageQuality: 0.85,
        compressVideoPreset: 'MediumQuality',
      });

      const uri = toFileUri(asset.path);
      const isVideo = asset.mime?.startsWith('video/');

      if (isVideo) {
        const durationMs =
          'duration' in asset && typeof asset.duration === 'number' ? asset.duration : null;
        if (durationMs != null && durationMs > MAX_VIDEO_DURATION_MS) {
          Alert.alert(
            'Video Too Long',
            `The selected video is ${Math.round(durationMs / 1000)} seconds. Please select a video shorter than ${MAX_VIDEO_DURATION_SECONDS} seconds.`,
            [{ text: 'OK', onPress: () => router.back() }]
          );
          return;
        }
        const compressedUri = await prepareVideoForUpload(uri);
        setPendingMedia({ uri: compressedUri, type: 'video', source: 'gallery' });
      } else {
        const optimizedUri = await prepareImageForUpload(uri);
        setPendingMedia({ uri: optimizedUri, type: 'photo', source: 'gallery' });
      }

      router.back();
    } catch (error: unknown) {
      const err = error as { code?: string; message?: string };
      if (err?.code === 'E_PICKER_CANCELLED') {
        router.back();
        return;
      }
      if (err?.code === 'E_NO_LIBRARY_PERMISSION') {
        Alert.alert('Permission Required', 'We need access to your photos to select media for your Reflections.', [
          { text: 'OK', onPress: () => router.back() },
        ]);
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
