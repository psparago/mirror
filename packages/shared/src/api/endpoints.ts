/**
 * API endpoint URLs for Google Cloud Functions
 */
export const API_ENDPOINTS = {
  GET_S3_URL: 'https://us-central1-project-mirror-23168.cloudfunctions.net/get-s3-url',
  LIST_MIRROR_EVENTS: 'https://us-central1-project-mirror-23168.cloudfunctions.net/list-mirror-events',
  DELETE_MIRROR_EVENT: 'https://us-central1-project-mirror-23168.cloudfunctions.net/delete-mirror-event',
  UNSPLASH_SEARCH: 'https://us-central1-project-mirror-23168.cloudfunctions.net/unsplash-search',
  AI_DESCRIPTION: 'https://us-central1-project-mirror-23168.cloudfunctions.net/generate-ai-description',
  GET_BATCH_S3_UPLOAD_URLS: 'https://us-central1-project-mirror-23168.cloudfunctions.net/get-batch-s3-upload-urls',
} as const;

