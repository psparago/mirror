import { useReflectionMedia } from '@/context/ReflectionMediaContext';
import { prepareImageForUpload, prepareVideoForUpload } from '@/utils/mediaProcessor';
import * as ImagePicker from 'expo-image-picker';
import { useNavigation, useRouter } from 'expo-router';
import React, { useEffect, useRef } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';

const MAX_VIDEO_DURATION_SECONDS = 60;
const MAX_VIDEO_DURATION_MS = MAX_VIDEO_DURATION_SECONDS * 1000;

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
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Required', 'We need access to your photos to select media for your Reflections.');
        router.back();
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        allowsEditing: true,
        quality: 0.85,
        videoMaxDuration: MAX_VIDEO_DURATION_SECONDS,
      });

      if (result.canceled || !result.assets?.[0]) {
        router.back();
        return;
      }

      const asset = result.assets[0];

      if (asset.type === 'video') {
        if (asset.duration && asset.duration > MAX_VIDEO_DURATION_MS) {
          Alert.alert(
            'Video Too Long',
            `The selected video is ${Math.round(asset.duration / 1000)} seconds. Please select a video shorter than ${MAX_VIDEO_DURATION_SECONDS} seconds.`,
            [{ text: 'OK', onPress: () => router.back() }]
          );
          return;
        }
        const compressedUri = await prepareVideoForUpload(asset.uri);
        setPendingMedia({ uri: compressedUri, type: 'video', source: 'gallery' });
      } else {
        const optimizedUri = await prepareImageForUpload(asset.uri);
        setPendingMedia({ uri: optimizedUri, type: 'photo', source: 'gallery' });
      }

      router.back();
    } catch (error: unknown) {
      const err = error as { code?: string; message?: string };
      if (err?.code === 'ERR_CANCELED') {
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
