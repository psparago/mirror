/**
 * S3 bucket and path constants
 */
export const S3_CONFIG = {
  BUCKET: 'mirror-uploads-sparago-2026',
  REGION: 'us-east-1',
  USER_ID: 'cole', // Will be replaced with Firebase UID later
} as const;

/**
 * S3 path prefixes
 */
export const S3_PATHS = {
  FROM_COLE: (userId: string = S3_CONFIG.USER_ID) => `${userId}/from/`,
  TO_COLE: (userId: string = S3_CONFIG.USER_ID) => `${userId}/to/`,
} as const;

