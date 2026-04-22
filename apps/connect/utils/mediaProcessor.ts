import * as FileSystem from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import { createVideoPlayer } from 'expo-video';
import { Image as RNImage, Platform } from 'react-native';
import { Video } from 'react-native-compressor';

const MAX_UPLOAD_WIDTH_PX = 1080;
/** Hard cap on source / trim window length (seconds) for Reflections Connect video. */
export const REFLECTION_MAX_VIDEO_SECONDS = 120;
export const REFLECTION_MAX_VIDEO_MS = REFLECTION_MAX_VIDEO_SECONDS * 1000;
/** Below this size (bytes), skip compression unless the file was just trimmed (preserves Space Saver originals). */
export const REFLECTION_SMALL_VIDEO_BYTES = 25 * 1024 * 1024;
/** Target long edge when compressing (720p cap, auto bitrate via compressor). */
const COMPRESS_MAX_DIMENSION_PX = 720;
export const PHOTO_EXPORT_SIZE_PX = 1080;

function isRemoteUri(uri: string): boolean {
  return uri.startsWith('http://') || uri.startsWith('https://');
}

function getErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const msg = (error as { message?: unknown }).message;
    return typeof msg === 'string' ? msg : String(msg ?? '');
  }
  return String(error ?? '');
}

function isAndroidCodecUnsupportedForCompression(error: unknown): boolean {
  const msg = getErrorMessage(error).toLowerCase();
  // Seen on Pixel when Google Photos exports Dolby Vision sources that compressor can't init.
  return Platform.OS === 'android' && (msg.includes('video/dolby-vision') || msg.includes('name_not_found'));
}

/**
 * Normalize bare filesystem paths to `file://`. Remote and provider URIs stay unchanged.
 * Important: Android gallery / Google Photos often returns `content://`; never prefix `file://`
 * on those or you get invalid `file://content://...` URIs that break compressor and video players.
 */
export function ensureFileUri(path: string): string {
  if (!path) return path;
  if (
    path.startsWith('http://') ||
    path.startsWith('https://') ||
    path.startsWith('file://') ||
    path.startsWith('content://') ||
    path.startsWith('ph://') ||
    path.startsWith('assets-library://')
  ) {
    return path;
  }
  const stripped = path.replace(/^file:\/\//, '');
  return `file://${stripped}`;
}

/** Undo mistaken `file://` + provider URI (legacy bug from old ensureFileUri). */
function normalizePickerUri(uri: string): string {
  const u = uri.trim();
  if (u.startsWith('file://content://')) return u.slice('file://'.length);
  if (u.startsWith('file://ph://')) return u.slice('file://'.length);
  return u;
}

/**
 * `react-native-compressor` and `expo-video` need a real file path. Google Photos on Android
 * (and iCloud-backed picks on iOS) often supply `content://` / `ph://` that must be copied into
 * app cache first.
 */
export async function materializeVideoSourceToFileAsync(uri: string): Promise<string> {
  const u = normalizePickerUri(uri);
  if (u.startsWith('http://') || u.startsWith('https://')) {
    return u;
  }
  if (u.startsWith('file://')) {
    return u;
  }
  if (u.startsWith('content://') || u.startsWith('ph://') || u.startsWith('assets-library://')) {
    if (!FileSystem.cacheDirectory) {
      throw new Error('FileSystem.cacheDirectory is not available');
    }
    const dest = `${FileSystem.cacheDirectory}video_pick_${Date.now()}_${Math.floor(Math.random() * 1e6)}.mp4`;
    await FileSystem.copyAsync({ from: u, to: dest });
    if (__DEV__) {
      console.log(`📁 [materializeVideoSource] ${Platform.OS} copied picker URI → ${dest}`);
    }
    return dest;
  }
  return ensureFileUri(u);
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

export type ProcessVideoOptions = {
  /** When true, always run compression (trim exports must be re-encoded for safe playback/size). */
  wasTrimmed?: boolean;
};

function normalizeOutputFileUri(pathOrUri: string): string {
  return pathOrUri.startsWith('file://') ? pathOrUri : `file://${pathOrUri}`;
}

/**
 * Safe-sync pipeline: small originals stay untouched; large or post-trim files are compressed to 720p
 * with auto bitrate. Any compressor failure falls back to the materialized/original file (never blocks upload).
 */
export async function processVideoForUpload(uri: string, options: ProcessVideoOptions = {}): Promise<string> {
  let sourceFile = uri;
  try {
    sourceFile = await materializeVideoSourceToFileAsync(uri);
  } catch (e) {
    console.error('[processVideoForUpload] materialize failed, trying original URI:', e);
    sourceFile = normalizePickerUri(uri);
  }

  const sourceForReturn = sourceFile.startsWith('file://') ? sourceFile : ensureFileUri(sourceFile);

  let skipCompress = false;
  try {
    const info = await FileSystem.getInfoAsync(sourceForReturn, { size: true });
    if (info.exists && typeof info.size === 'number') {
      skipCompress = !options.wasTrimmed && info.size < REFLECTION_SMALL_VIDEO_BYTES;
    }
  } catch {
    // size unknown — still compress when trimmed; otherwise attempt compress for safety on huge unknowns
    skipCompress = false;
  }

  if (skipCompress) {
    if (__DEV__) {
      console.log(
        `[processVideoForUpload] skip compression (file < ${REFLECTION_SMALL_VIDEO_BYTES} bytes, not trimmed)`
      );
    }
    return sourceForReturn;
  }

  try {
    console.log(`🎬 Compressing video: ${sourceForReturn}`);
    const sourceDurationSec = await probeLocalVideoDurationSeconds(sourceForReturn);

    const compressOptions: Record<string, unknown> = {
      compressionMethod: 'auto',
      minimumFileSizeForCompress: 0,
      maxSize: COMPRESS_MAX_DIMENSION_PX,
    };

    const result = await Video.compress(sourceForReturn, compressOptions as never, () => {});
    const finalUri = normalizeOutputFileUri(result);

    const compressedDurationSec = await probeLocalVideoDurationSeconds(finalUri);
    const minExpectedDurationSec =
      sourceDurationSec > 0 ? Math.max(0.5, sourceDurationSec * 0.5) : 0.5;
    if (compressedDurationSec < minExpectedDurationSec) {
      console.warn(
        `[processVideoForUpload] compressed output failed validation (src=${sourceDurationSec.toFixed(3)}s, out=${compressedDurationSec.toFixed(3)}s); falling back to source`
      );
      return sourceForReturn;
    }

    console.log(`✅ Video compressed: ${finalUri}`);
    return finalUri;
  } catch (error) {
    if (isAndroidCodecUnsupportedForCompression(error)) {
      console.warn('[processVideoForUpload] compression skipped (unsupported Android codec); using source');
    } else {
      console.error('[processVideoForUpload] compress failed; using source:', error);
    }
    return sourceForReturn;
  }
}

export async function prepareVideoForUpload(uri: string): Promise<string> {
  return processVideoForUpload(uri, {});
}

/**
 * One-off duration read for local validation / metadata fallback. Uses a disposable player so the
 * workbench composer can own the only long-lived `VideoPlayer` (Android struggles with two
 * players on the same file).
 */
export async function probeLocalVideoDurationSeconds(uri: string): Promise<number> {
  const normalized = normalizePickerUri(uri.trim());
  let workUri = normalized;
  if (workUri.startsWith('content://') || workUri.startsWith('ph://')) {
    try {
      workUri = await materializeVideoSourceToFileAsync(normalized);
    } catch {
      return 0;
    }
  } else if (
    !workUri.startsWith('file://') &&
    !workUri.startsWith('http://') &&
    !workUri.startsWith('https://')
  ) {
    workUri = ensureFileUri(workUri);
  }

  const player = createVideoPlayer(workUri);
  try {
    player.loop = false;
    try {
      player.pause();
    } catch {
      /* ignore */
    }
    for (let i = 0; i < 60; i++) {
      if (player.duration > 0) {
        return player.duration;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return 0;
  } finally {
    try {
      player.replace('');
    } catch {
      /* ignore */
    }
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
