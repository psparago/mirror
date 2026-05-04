import { useReflectionMedia } from '@/context/ReflectionMediaContext';
import {
  ensureFileUri,
  isUsableVideoDurationSeconds,
  LARGE_VIDEO_WARN_BYTES,
  materializeVideoSourceToFileAsync,
  prepareImageForUpload,
  probeLocalVideoDurationSeconds,
} from '@/utils/mediaProcessor';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { FontAwesome } from '@expo/vector-icons';
import * as ExpoImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { useNavigation, useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
  PermissionsAndroid,
  Platform,
  StyleSheet,
  View,
} from 'react-native';
import { useWaitOverlay } from '@projectmirror/shared';

type GalleryPrompt = {
  title: string;
  detail: string;
  icon: React.ReactNode;
  actionLabel: string;
  onAction: () => void;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
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

export default function GalleryScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const { setPendingMedia } = useReflectionMedia();
  const waitOverlay = useWaitOverlay();
  const hasLaunched = useRef(false);
  const cancelledRef = useRef(false);
  const waitOverlayIdRef = useRef('connect-gallery-wait-overlay');
  const [statusLine, setStatusLine] = useState('Loading from media library…');
  const [statusDetail, setStatusDetail] = useState('Thanks for your patience. Larger videos can take a little while to get ready.');
  const [prepStep, setPrepStep] = useState(0);
  const [waitIcon, setWaitIcon] = useState<'folder-open' | 'photo' | 'video-camera' | 'cloud-upload'>('folder-open');
  const [isProcessing, setIsProcessing] = useState(false);
  const [prompt, setPrompt] = useState<GalleryPrompt | null>(null);

  useEffect(() => {
    if (prompt) {
      waitOverlay.show(
        {
          title: prompt.title,
          detail: prompt.detail,
          icon: prompt.icon,
          isLoading: false,
          tone: 'media',
          actionLabel: prompt.actionLabel,
          onAction: prompt.onAction,
          secondaryActionLabel: prompt.secondaryActionLabel,
          onSecondaryAction: prompt.onSecondaryAction,
        },
        waitOverlayIdRef.current
      );
      return;
    }

    if (isProcessing) {
      waitOverlay.show(
        {
          title: statusLine,
          detail: statusDetail,
          icon: <FontAwesome name={waitIcon} size={20} color="#dbeafe" />,
          progress: prepStep / 7,
          tone: 'media',
          actionLabel: 'Cancel',
          onAction: () => {
            cancelledRef.current = true;
            router.back();
          },
        },
        waitOverlayIdRef.current
      );
      return;
    }

    waitOverlay.hide(waitOverlayIdRef.current);
  }, [isProcessing, prepStep, prompt, router, statusDetail, statusLine, waitIcon, waitOverlay]);

  useEffect(() => {
    return () => waitOverlay.hide(waitOverlayIdRef.current);
  }, [waitOverlay]);

  const returnCancelledSelection = (title: string, detail: string) => {
    setPendingMedia({
      uri: 'cancelled://gallery',
      type: 'video',
      source: 'gallery',
      cancelled: true,
      cancelTitle: title,
      cancelDetail: detail,
    });
    router.back();
  };

  const closeWithPrompt = (title: string, detail: string, iconName: React.ComponentProps<typeof FontAwesome>['name']) => {
    setPrompt({
      title,
      detail,
      icon: <FontAwesome name={iconName} size={20} color="#dbeafe" />,
      actionLabel: 'OK',
      onAction: () => {
        setPrompt(null);
        router.back();
      },
    });
  };

  const confirmLargeVideoAsync = async (sizeBytes?: number | null): Promise<boolean> => {
    if (typeof sizeBytes === 'number' && sizeBytes < LARGE_VIDEO_WARN_BYTES) return true;
    const sizeMb = typeof sizeBytes === 'number' ? Math.round(sizeBytes / (1024 * 1024)) : null;
    const message =
      sizeMb != null
        ? `This Reflection video is about ${sizeMb} MB. It may take a minute or more to polish for smooth playback, so please keep Reflections Connect open. Continue?`
        : 'This video may take a minute or more to polish for smooth playback, so please keep Reflections Connect open. Continue?';
    return await new Promise((resolve) => {
      setPrompt({
        title: 'Large video selected',
        detail: message,
        icon: <FontAwesome name="video-camera" size={20} color="#dbeafe" />,
        secondaryActionLabel: 'Cancel',
        onSecondaryAction: () => {
          setPrompt(null);
          resolve(false);
        },
        actionLabel: 'Continue',
        onAction: () => {
          setPrompt(null);
          resolve(true);
        },
      });
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
        closeWithPrompt(
          'Permission Required',
          'Reflections Connect needs access to your photos and videos to pick from the gallery.',
          'lock'
        );
        return;
      }

      const libPerm = await ExpoImagePicker.requestMediaLibraryPermissionsAsync();
      if (!libPerm.granted) {
        closeWithPrompt(
          'Permission Required',
          'We need access to your photo library to choose images and videos for your Reflections.',
          'lock'
        );
        return;
      }

      setStatusLine('Loading from media library…');
      setStatusDetail('Thanks for your patience. Larger videos can take a little while to get ready.');
      setPrepStep(1);
      setWaitIcon('folder-open');
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
      setStatusLine(
        isVideo ? 'Video selected. Preparing it now…' : 'Photo selected. Preparing it now…'
      );
      setStatusDetail(
        isVideo
          ? 'Reflections Connect is getting the selected video ready.'
          : 'Reflections Connect is getting the selected photo ready.'
      );
      setPrepStep(2);
      setWaitIcon(isVideo ? 'video-camera' : 'photo');
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      console.log('[GalleryScreen] media selected', {
        type: isVideo ? 'video' : 'photo',
        uri: asset.uri,
        mimeType: asset.mimeType,
        fileSize: asset.fileSize,
      });

      if (isVideo) {
        setStatusLine('Preparing video for your Reflection…');
        setStatusDetail('Checking video size before preparing playback.');
        setPrepStep(3);
        setWaitIcon('video-camera');
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
        let largeVideoConfirmed = false;
        const shouldContinue = await confirmLargeVideoAsync(detectedSizeBytes);
        if (!shouldContinue) {
          returnCancelledSelection(
            'Video preparation didn\'t finish',
            'Reflections Connect didn\'t prepare the selected large video. Choose a smaller clip, trim/export this video from Photos, or try again when you have time to keep the app open.'
          );
          return;
        }
        largeVideoConfirmed =
          detectedSizeBytes == null || detectedSizeBytes >= LARGE_VIDEO_WARN_BYTES;
        if (detectedSizeBytes && detectedSizeBytes >= LARGE_VIDEO_WARN_BYTES) {
          setStatusLine('Large video detected…');
          setStatusDetail('Large videos take longer because they are copied and prepared first.');
        }
        let fileUri = expoUri;
        try {
          setStatusLine('Copying video into Reflections…');
          setStatusDetail('Keeping a local working copy so preparation is reliable.');
          setPrepStep(4);
          fileUri = await materializeVideoSourceToFileAsync(expoUri);
        } catch {
          fileUri = expoUri;
        }
        if (!largeVideoConfirmed) {
          try {
            const materializedInfo = await FileSystem.getInfoAsync(fileUri, { size: true });
            const materializedSize =
              materializedInfo.exists && typeof materializedInfo.size === 'number'
                ? materializedInfo.size
                : null;
            const shouldContinueMaterialized = await confirmLargeVideoAsync(materializedSize);
            if (!shouldContinueMaterialized) {
              returnCancelledSelection(
                'Video preparation didn\'t finish',
                'Reflections Connect didn\'t prepare the selected large video. Choose a smaller clip, trim/export this video from Photos, or try again when you have time to keep the app open.'
              );
              return;
            }
            if (materializedSize && materializedSize >= LARGE_VIDEO_WARN_BYTES) {
              setStatusLine('Large video detected…');
              setStatusDetail('Large videos take longer because they are copied and prepared first.');
            }
          } catch {
            // size probe is best-effort; continue to strict duration validation below
          }
        }
        setStatusLine('Reading video details…');
        setStatusDetail('Checking duration and making sure the clip can be opened.');
        setPrepStep(5);
        const durationSec = await probeLocalVideoDurationSeconds(fileUri);
        if (!isUsableVideoDurationSeconds(durationSec)) {
          closeWithPrompt(
            'Can\'t use this clip',
            'Reflections Connect couldn’t read this video. Try another video, or trim/export it from Photos first.',
            'exclamation-triangle'
          );
          return;
        }
        const durationMs = Math.round(durationSec * 1000);
        /** Best-effort decode check (expo-video-thumbnails); Sparkle Composer re-validates — no native trim UI. */
        try {
          if (durationMs > 0 && fileUri) {
            setStatusLine('Finding a preview frame…');
            setStatusDetail('Preparing the first image you will see in the workbench.');
            setPrepStep(6);
            const atMs = Math.min(600, Math.max(1, durationMs - 1));
            await VideoThumbnails.getThumbnailAsync(ensureFileUri(fileUri), {
              time: atMs,
            });
          }
        } catch {
          /* Long masters often still decode in Composer; picker alone is not authoritative. */
        }
        if (cancelledRef.current) return;
        setStatusLine('Preparing your video for Reflection…');
        setStatusDetail('Opening the workbench next.');
        setPrepStep(7);
        setWaitIcon('cloud-upload');
        setPendingMedia({
          uri: ensureFileUri(fileUri),
          type: 'video',
          source: 'gallery',
        });
      } else {
        setStatusLine('Preparing photo for your Reflection…');
        setStatusDetail('Optimizing the image for upload.');
        setPrepStep(3);
        setWaitIcon('photo');
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
        closeWithPrompt(
          'Permission Required',
          'We need access to your photos to select media for your Reflections.',
          'lock'
        );
        return;
      }
      console.error('Gallery picker error:', error);
      closeWithPrompt('Error', 'Failed to pick media from gallery', 'exclamation-triangle');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <View style={styles.container} />
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
