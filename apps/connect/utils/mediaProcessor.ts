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
export const REFLECTION_SMALL_VIDEO_BYTES = 50 * 1024 * 1024;
/** Warn before work that is likely to trigger expensive video conditioning. */
export const LARGE_VIDEO_WARN_BYTES = REFLECTION_SMALL_VIDEO_BYTES;
/** Target long edge when compressing (1080p cap, auto bitrate via compressor). */
const COMPRESS_MAX_DIMENSION_PX = 1920;
const COMPRESS_MIN_BITRATE = 2_000_000;
export const PHOTO_EXPORT_SIZE_PX = 1080;

export class VideoPreparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoPreparationError';
  }
}

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

export function isUsableVideoDurationSeconds(durationSec: number | null | undefined): durationSec is number {
  return typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0;
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

const VOLATILE_THUMB_URI_PATTERN = /VideoThumbnails/i;

/**
 * `expo-video-thumbnails` often writes under the system cache (e.g. …/Caches/VideoThumbnails/).
 * Those files can be removed or unreadable by the time `ImageManipulator` / upload runs — copy into
 * `cacheDirectory` first.
 */
export async function stabilizeLocalImageFileAsync(uri: string, label: string): Promise<string> {
  if (isRemoteUri(uri)) return uri.trim();
  if (!FileSystem.cacheDirectory) {
    return ensureFileUri(normalizePickerUri(uri));
  }
  const fromRaw = normalizePickerUri(uri.trim());
  const fromUri =
    fromRaw.startsWith('file://') ||
    fromRaw.startsWith('content://') ||
    fromRaw.startsWith('ph://') ||
    fromRaw.startsWith('assets-library://')
      ? fromRaw
      : ensureFileUri(fromRaw);
  const ext = guessFileExtensionFromUri(fromUri) || 'jpg';
  const dest = `${FileSystem.cacheDirectory}${label}_${Date.now()}_${Math.floor(Math.random() * 1e6)}.${ext}`;
  try {
    await FileSystem.copyAsync({ from: fromUri, to: dest });
    return dest;
  } catch (e) {
    console.warn('[stabilizeLocalImageFileAsync] copy failed; using original uri', e);
    return fromUri.startsWith('file://') || fromUri.startsWith('content://') ? fromUri : ensureFileUri(fromUri);
  }
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
    const ext = guessVideoExtensionFromUri(u);
    const dest = `${FileSystem.cacheDirectory}video_pick_${Date.now()}_${Math.floor(Math.random() * 1e6)}.${ext}`;
    await FileSystem.copyAsync({ from: u, to: dest });
    return dest;
  }
  return ensureFileUri(u);
}

function guessVideoExtensionFromUri(uri: string): string {
  try {
    const urlPath = uri.split('?')[0];
    const lastSegment = urlPath.split('/').pop() || '';
    const ext = lastSegment.includes('.') ? (lastSegment.split('.').pop() || '').toLowerCase() : '';
    if (
      ext &&
      ['mp4', 'mov', 'm4v', '3gp', 'mkv', 'webm'].includes(ext)
    ) {
      return ext;
    }
  } catch {
    // ignore
  }
  return 'mp4';
}

export function isLikelyMp4VideoUri(uri: string): boolean {
  try {
    const path = normalizePickerUri(uri).split('?')[0].toLowerCase();
    return path.endsWith('.mp4') || path.endsWith('.m4v');
  } catch {
    return false;
  }
}

export function hasKnownNonMp4VideoExtension(uri: string): boolean {
  try {
    const path = normalizePickerUri(uri).split('?')[0].toLowerCase();
    const ext = path.includes('.') ? path.split('.').pop() : '';
    return !!ext && ['mov', '3gp', 'mkv', 'webm'].includes(ext);
  } catch {
    return false;
  }
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
    } else if (VOLATILE_THUMB_URI_PATTERN.test(localUri)) {
      localUri = await stabilizeLocalImageFileAsync(localUri, 'gatekeeper_thumb');
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
  /** Force compression regardless of source size (used for camera captures). */
  alwaysCompress?: boolean;
  onProgress?: (progress: VideoProcessProgress) => void;
};

export type VideoProcessProgress = {
  stage: 'materializing' | 'checking' | 'compressing' | 'validating' | 'ready';
  progress: number | null;
};

function normalizeOutputFileUri(pathOrUri: string): string {
  return pathOrUri.startsWith('file://') ? pathOrUri : `file://${pathOrUri}`;
}

async function compressVideoSourceAsync(
  sourceForReturn: string,
  logTag: string,
  onProgress?: ProcessVideoOptions['onProgress']
): Promise<string> {
  try {
    onProgress?.({ stage: 'checking', progress: null });
    const sourceDurationSec = await probeLocalVideoDurationSeconds(sourceForReturn);
    if (!isUsableVideoDurationSeconds(sourceDurationSec)) {
      throw new VideoPreparationError('Reflections Connect could not read this video duration.');
    }

    const compressOptions: Record<string, unknown> = {
      compressionMethod: 'auto',
      minimumBitrate: COMPRESS_MIN_BITRATE,
      minimumFileSizeForCompress: 0,
      maxSize: COMPRESS_MAX_DIMENSION_PX,
    };

    onProgress?.({ stage: 'compressing', progress: 0 });
    const result = await Video.compress(sourceForReturn, compressOptions as never, (progress: number) => {
      const normalizedProgress = Number.isFinite(progress)
        ? Math.max(0, Math.min(1, progress > 1 ? progress / 100 : progress))
        : 0;
      onProgress?.({ stage: 'compressing', progress: normalizedProgress });
    });
    const finalUri = normalizeOutputFileUri(result);

    onProgress?.({ stage: 'validating', progress: null });
    const compressedDurationSec = await probeLocalVideoDurationSeconds(finalUri);
    const minExpectedDurationSec =
      sourceDurationSec > 0 ? Math.max(0.5, sourceDurationSec * 0.5) : 0.5;
    if (
      !isUsableVideoDurationSeconds(compressedDurationSec) ||
      compressedDurationSec < minExpectedDurationSec
    ) {
      console.warn(
        `[${logTag}] compressed output failed validation (src=${sourceDurationSec.toFixed(3)}s, out=${isUsableVideoDurationSeconds(compressedDurationSec) ? compressedDurationSec.toFixed(3) : 'unreadable'}s); falling back to source`
      );
      if (!isLikelyMp4VideoUri(sourceForReturn)) {
        throw new VideoPreparationError(
          'Reflections Connect could not prepare this video as an MP4. Please trim or export it from Photos and try again.'
        );
      }
      return sourceForReturn;
    }

    onProgress?.({ stage: 'ready', progress: 1 });
    return finalUri;
  } catch (error) {
    if (error instanceof VideoPreparationError) {
      throw error;
    }
    if (isAndroidCodecUnsupportedForCompression(error)) {
      console.warn(`[${logTag}] compression skipped (unsupported Android codec); using source`);
    } else {
      console.error(`[${logTag}] compress failed; using source:`, error);
    }
    if (!isLikelyMp4VideoUri(sourceForReturn)) {
      throw new VideoPreparationError(
        'Reflections Connect could not prepare this video as an MP4. Please trim or export it from Photos and try again.'
      );
    }
    return sourceForReturn;
  }
}

export type CompressVideoIfNeededOptions = {
  /** Force compression regardless of source size (used for camera captures). */
  alwaysCompress?: boolean;
};

export async function compressVideoIfNeededAsync(
  uri: string,
  options: CompressVideoIfNeededOptions = {}
): Promise<string> {
  return processVideoForUpload(uri, { alwaysCompress: options.alwaysCompress });
}

/**
 * Safe-sync pipeline: small MP4-like originals stay untouched on iOS; on Android we still transcode
 * sub-threshold clips so uploads use an H.264/AAC MP4 that decodes reliably on iOS (camera/gallery
 * encodes often skip compression for size and can play audio-only or show a blank layer there).
 * Large or post-trim files are compressed to 1080p with auto bitrate.
 * Compressor failure falls back only when the source is already MP4-like; obvious non-MP4 sources
 * are rejected so we do not upload a misleading `video.mp4` master.
 */
export async function processVideoForUpload(uri: string, options: ProcessVideoOptions = {}): Promise<string> {
  let sourceFile = uri;
  try {
    options.onProgress?.({ stage: 'materializing', progress: null });
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
      skipCompress =
        !options.wasTrimmed &&
        !options.alwaysCompress &&
        info.size < REFLECTION_SMALL_VIDEO_BYTES &&
        Platform.OS !== 'android' &&
        isLikelyMp4VideoUri(sourceForReturn);
    }
  } catch {
    // size unknown — still compress when trimmed; otherwise attempt compress for safety on huge unknowns
    skipCompress = false;
  }

  if (skipCompress) {
    options.onProgress?.({ stage: 'ready', progress: 1 });
    return sourceForReturn;
  }

  return compressVideoSourceAsync(sourceForReturn, 'processVideoForUpload', options.onProgress);
}

export async function prepareVideoForUpload(uri: string): Promise<string> {
  return processVideoForUpload(uri, {});
}

/**
 * One-off duration read for local validation / metadata fallback. Uses a disposable player so the
 * workbench composer can own the only long-lived `VideoPlayer` (Android struggles with two
 * players on the same file).
 */
export async function probeLocalVideoDurationSeconds(uri: string): Promise<number | null> {
  const normalized = normalizePickerUri(uri.trim());
  let workUri = normalized;
  if (workUri.startsWith('content://') || workUri.startsWith('ph://')) {
    try {
      workUri = await materializeVideoSourceToFileAsync(normalized);
    } catch {
      return null;
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
    return null;
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
  if (!uri || isRemoteUri(uri) || !uri.startsWith('file://')) return;
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    /* ignore */
  }
}
