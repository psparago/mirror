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
}

export interface Event {
  event_id: string;
  image_url: string;
  metadata_url: string;
  metadata?: EventMetadata;
}

export interface ListEventsResponse {
  events: Event[];
}

