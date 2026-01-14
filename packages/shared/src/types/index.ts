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
  // Note: audio_url/video_url are NOT stored in metadata.json (presigned URLs expire)
  // The backend ListMirrorEvents generates fresh presigned GET URLs in the Event object
  content_type?: 'text' | 'audio' | 'video';
  image_source?: 'camera' | 'search'; // Where the image came from
  // AI-generated dual-story fields
  short_caption?: string; // Brief greeting - auto-played on load
  deep_dive?: string; // Detailed story - played when ✨ is tapped
  deep_dive_audio_url?: string; // Optional TTS for deep dive
}

export interface Event {
  event_id: string;
  image_url: string; // Always a JPG/PNG (Thumbnail for video events)
  metadata_url: string;
  audio_url?: string; // Optional presigned GET URL for audio.m4a
  video_url?: string; // Optional presigned GET URL for video.mp4
  deep_dive_audio_url?: string; // Optional presigned GET URL for deep_dive.m4a
  metadata?: EventMetadata;
  refreshedAt?: number; // Local timestamp when URLs were last refreshed
}

export interface ListEventsResponse {
  events: Event[];
}