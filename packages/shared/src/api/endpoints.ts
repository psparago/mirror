/**
 * API endpoint URLs for Google Cloud Functions
 * Project: Reflections (reflections-1200b)
 */
export const API_ENDPOINTS = {
  GET_S3_URL: 'https://us-central1-reflections-1200b.cloudfunctions.net/get-s3-url',
  LIST_MIRROR_EVENTS: 'https://us-central1-reflections-1200b.cloudfunctions.net/list-mirror-events',
  DELETE_MIRROR_EVENT: 'https://us-central1-reflections-1200b.cloudfunctions.net/delete-mirror-event',
  UNSPLASH_SEARCH: 'https://us-central1-reflections-1200b.cloudfunctions.net/unsplash-search',
  AI_DESCRIPTION: 'https://us-central1-reflections-1200b.cloudfunctions.net/generate-ai-description',
  GET_BATCH_S3_UPLOAD_URLS: 'https://us-central1-reflections-1200b.cloudfunctions.net/get-batch-s3-upload-urls',
  GET_EVENT_BUNDLE: 'https://us-central1-reflections-1200b.cloudfunctions.net/get-event-bundle',
  GET_VOICE_SAMPLE: 'https://us-central1-reflections-1200b.cloudfunctions.net/get-voice-sample',
} as const;