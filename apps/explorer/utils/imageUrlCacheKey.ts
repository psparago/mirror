import type { ImageSource } from 'expo-image';

/**
 * Short stable key for expo-image / SDWebImage so cache lookups avoid hashing
 * very long S3 presigned query strings. The HTTP request still uses the full `uri`.
 */
export function imageUrlCacheKey(uri: string | undefined | null): string | undefined {
  if (!uri || typeof uri !== 'string') return undefined;
  const q = uri.indexOf('?');
  const key = q === -1 ? uri : uri.slice(0, q);
  return key.length > 0 ? key : undefined;
}

/** Build a memo-friendly expo-image source object with a stable cache key. */
export function buildStableImageSource(
  uri: string | undefined | null,
  dimensions?: { width?: number; height?: number },
): ImageSource | undefined {
  if (!uri) return undefined;
  const cacheKey = imageUrlCacheKey(uri);
  return {
    uri,
    ...(cacheKey ? { cacheKey } : {}),
    ...(typeof dimensions?.width === 'number' ? { width: dimensions.width } : {}),
    ...(typeof dimensions?.height === 'number' ? { height: dimensions.height } : {}),
  };
}
