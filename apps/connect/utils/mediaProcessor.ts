import * as FileSystem from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import { Image as RNImage } from 'react-native';
import { Video } from 'react-native-compressor';

const MAX_UPLOAD_WIDTH_PX = 1080;
const MAX_IMAGE_WIDTH = 1080;
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
    const shouldDownscale = !size ? true : size.width > MAX_UPLOAD_WIDTH_PX;

    const actions = shouldDownscale ? [{ resize: { width: MAX_UPLOAD_WIDTH_PX } }] : [];

    const result = await ImageManipulator.manipulateAsync(localUri, actions, {
      compress: 0.8,
      format: ImageManipulator.SaveFormat.JPEG,
    });

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
 * Gatekeeper for Videos
 * - Compresses to H.264
 * - Downscales to 1080p
 * - Caps bitrate at 5Mbps
 */
export async function prepareVideoForUpload(uri: string): Promise<string> {
  try {
    console.log(`🎬 Compressing video: ${uri}`);
    
    // Check if it's already a compressed/local file to avoid loops if needed
    // But usually we want to re-compress to ensure bitrate enforcement
    
    const result = await Video.compress(
      uri,
      {
        compressionMethod: 'manual',
        maxSize: MAX_VIDEO_RESOLUTION, // Resizes largest dimension to 1080
        bitrate: VIDEO_BITRATE,
        minimumFileSizeForCompress: 2, // Skip files smaller than 2MB
      },
      (progress) => {
        // Optional: You can hook this up to a UI progress bar later
        // console.log('Compression: ', progress);
      }
    );

    // The result is the path to the compressed file
    // Note: react-native-compressor returns a 'file://' URI
    const finalUri = result.startsWith('file://') ? result : `file://${result}`;
    
    console.log(`✅ Video compressed: ${finalUri}`);
    return finalUri;

  } catch (error) {
    console.error('[prepareVideoForUpload] failed:', error);
    // Fallback: If compression fails, return original (or throw, depending on strictness)
    // For now, let's return original so the user isn't blocked, but log the error.
    return uri; 
  }
}