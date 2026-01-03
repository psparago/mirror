/**
 * Shared TypeScript types and interfaces
 */

export interface PhotoItem {
  url: string;
}

export interface S3UploadResponse {
  url: string;
}

export interface ListPhotosResponse {
  objects: string[];
}

export interface EventMetadata {
  description: string;
  sender: string;
  timestamp: string;
  event_id: string;
  // Note: audio_url is NOT stored in metadata.json (presigned URLs expire)
  // The backend ListMirrorEvents generates fresh presigned GET URLs in the Event object
  content_type?: 'text' | 'audio'; // Whether to use TTS (text) or play audio (audio)
  // AI-generated dual-story fields (optional)
  short_caption?: string; // Brief greeting - auto-played on load
  deep_dive?: string; // Detailed story - played when ✨ is tapped
}

export interface Event {
  event_id: string;
  image_url: string;
  metadata_url: string;
  audio_url?: string; // Optional presigned GET URL for audio.m4a file
  metadata?: EventMetadata;
}

export interface ListEventsResponse {
  events: Event[];
}

