import * as FileSystem from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import { Image as RNImage } from 'react-native';
import { Video } from 'react-native-compressor';

const MAX_UPLOAD_WIDTH_PX = 1080;
const VIDEO_BITRATE = 5 * 1000 * 1000; // 5 Mbps
const MAX_VIDEO_RESOLUTION = 1080; // 1080p
export const PHOTO_EXPORT_SIZE_PX = 1080;

function isRemoteUri(uri: string): boolean {
  return uri.startsWith('http://') || uri.startsWith('https://');
}

/**
 * Normalize local media paths for RN / Expo (`file://`), including Expo ImagePicker URIs.
 * Remote `http(s)` URIs are returned unchanged.
 */
export function ensureFileUri(path: string): string {
  if (!path) return path;
  if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('file://')) {
    return path;
  }
  const stripped = path.replace(/^file:\/\//, '');
  return `file://${stripped}`;
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

export type ContainedPhotoMetrics = {
  fittedWidth: number;
  fittedHeight: number;
  maxOffsetX: number;
  maxOffsetY: number;
};

/**
 * Computes how a source photo fits into a square stage at the current scale.
 * Translation can then be clamped to +/- `maxOffsetX` / `maxOffsetY`.
 */
export function getContainedPhotoMetrics(
  sourceWidth: number,
  sourceHeight: number,
  stageSize: number,
  scale: number,
): ContainedPhotoMetrics {
  const safeWidth = Math.max(1, sourceWidth);
  const safeHeight = Math.max(1, sourceHeight);
  const safeStage = Math.max(1, stageSize);
  const aspect = safeWidth / safeHeight;
  const fittedWidth = aspect >= 1 ? safeStage : safeStage * aspect;
  const fittedHeight = aspect >= 1 ? safeStage / aspect : safeStage;
  return {
    fittedWidth,
    fittedHeight,
    maxOffsetX: Math.max(0, (fittedWidth * scale - safeStage) / 2),
    maxOffsetY: Math.max(0, (fittedHeight * scale - safeStage) / 2),
  };
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
    // Photo editing now exports a square stage separately; gatekeeper still caps width and JPEG-encodes.
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
