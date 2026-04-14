import * as FileSystem from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import { Image as RNImage } from 'react-native';
import { Video } from 'react-native-compressor';

const MAX_UPLOAD_WIDTH_PX = 1080;
const VIDEO_BITRATE = 5 * 1000 * 1000; // 5 Mbps
const MAX_VIDEO_RESOLUTION = 1080; // 1080p

function isRemoteUri(uri: string): boolean {
  return uri.startsWith('http://') || uri.startsWith('https://');
}

function guessFileExtensionFromUri(uri: string): string {
  // Best-effort: used only to name the downloaded temp file.
  // The output of this utility is always JPEG.
  try {
    const urlPath = uri.split('?')[0];
    const lastSegment = urlPath.split('/').pop() || '';
    const ext = lastSegment.includes('.') ? (lastSegment.split('.').pop() || '').toLowerCase() : '';
    if (ext && ext.length <= 5 && !ext.includes('/')) return ext;
  } catch {
    // ignore
  }
  return 'jpg';
}

async function getImageSizeAsync(uri: string): Promise<{ width: number; height: number } | null> {
  return await new Promise((resolve) => {
    RNImage.getSize(
      uri,
      (width, height) => resolve({ width, height }),
      () => resolve(null)
    );
  });
}

/**
 * Gatekeeper: Returns a local, cache-based JPEG URI that is guaranteed to be <= 1080px wide.
 * - Remote URIs are downloaded to cache first.
 * - Images wider than 1080px are resized down to 1080px.
 * - Images are encoded as JPEG with compress=0.8.
 */
export async function prepareImageForUpload(uri: string): Promise<string> {
  try {
    let localUri = uri;
    let downloadedUri: string | null = null;

    if (isRemoteUri(uri)) {
      if (!FileSystem.cacheDirectory) {
        throw new Error('FileSystem.cacheDirectory is not available');
      }
      const ext = guessFileExtensionFromUri(uri);
      const downloadTarget = `${FileSystem.cacheDirectory}gatekeeper_${Date.now()}_${Math.floor(
        Math.random() * 1000
      )}.${ext}`;

      const downloadRes = await FileSystem.downloadAsync(uri, downloadTarget);
      localUri = downloadRes.uri;
      downloadedUri = downloadRes.uri;
    }

    const size = await getImageSizeAsync(localUri);
    // Native crop (e.g. react-native-image-crop-picker at 1080×1080) is already ≤ 1080 wide; only resize when wider.
    const shouldDownscale = !size ? true : size.width > MAX_UPLOAD_WIDTH_PX;

    const result = await ImageManipulator.manipulateAsync(
      localUri,
      shouldDownscale ? [{ resize: { width: MAX_UPLOAD_WIDTH_PX } }] : [],
      {
        compress: 0.8,
        format: ImageManipulator.SaveFormat.JPEG,
      }
    );

    // Best-effort cleanup of intermediate downloaded file (cache only).
    if (downloadedUri && downloadedUri !== result.uri) {
      FileSystem.deleteAsync(downloadedUri, { idempotent: true }).catch(() => {});
    }

    return result.uri;
  } catch (error) {
    console.error('[prepareImageForUpload] failed:', error);
    throw error;
  }
}

/**
 * Gatekeeper for videos: compress the **full** source file (no physical trim).
 * Playback windows (`video_start_ms` / `video_end_ms`) are metadata-only (cloud master).
 */
export async function prepareVideoForUpload(uri: string): Promise<string> {
  try {
    console.log(`🎬 Compressing video: ${uri}`);

    const compressOptions: Record<string, unknown> = {
      compressionMethod: 'manual',
      maxSize: MAX_VIDEO_RESOLUTION,
      bitrate: VIDEO_BITRATE,
      minimumFileSizeForCompress: 2,
    };

    const result = await Video.compress(uri, compressOptions as never, () => {});

    const finalUri = result.startsWith('file://') ? result : `file://${result}`;

    console.log(`✅ Video compressed: ${finalUri}`);
    return finalUri;
  } catch (error) {
    console.error('[prepareVideoForUpload] failed:', error);
    return uri;
  }
}

/** Best-effort delete of a local scratch file (e.g. filter-kit extract PNG, gatekeeper JPEG). */
export async function deleteScratchMediaFile(uri: string | null | undefined): Promise<void> {
  if (!uri || isRemoteUri(uri)) return;
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    /* ignore */
  }
}
