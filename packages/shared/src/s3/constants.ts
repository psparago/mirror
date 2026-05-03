/**
 * S3 bucket and path constants
 */
export const S3_CONFIG = {
  BUCKET: 'reflections-1200b-storage',
  REGION: 'us-east-1',
} as const;

/**
 * S3 path prefixes
 */
export const S3_PATHS = {
  FROM: (userId: string) => `${userId}/from/`,
  TO: (userId: string) => `${userId}/to/`,
} as const;


