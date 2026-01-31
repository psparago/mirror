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
  metadata_url?: string;
  audio_url?: string; // Optional presigned GET URL for audio.m4a
  video_url?: string; // Optional presigned GET URL for video.mp4
  deep_dive_audio_url?: string; // Optional presigned GET URL for deep_dive.m4a
  metadata?: EventMetadata;
  refreshedAt?: number; // Local timestamp when URLs were last refreshed
}

export interface ListEventsResponse {
  events: Event[];
}

export type UserRole = 'owner' | 'admin' | 'contributor';

// Represents the link between a Companion and an Explorer
export interface ExplorerConnection {
  explorer_id: string;
  role: UserRole;
  nickname?: string; // e.g. "Cole" - What the companion calls this explorer locally
  joined_at: string; // ISO timestamp
}

// The Companion (User) Document
// Collection: users
export interface UserProfile {
  uid: string;           // Matches Firebase Auth ID
  email: string;
  display_name?: string;
  photo_url?: string;    // Google/Apple profile pic
  connected_explorers: ExplorerConnection[]; // The list of Explorers this user can access
  created_at: string;
}

// The Explorer (Device/Context) Document
// Collection: explorers
export interface Explorer {
  explorer_id: string;   // Unique ID (e.g. "cole_mirror_01")
  name: string;          // e.g. "Cole's Reflection" (System name)
  owner_id: string;      // The Super Admin (You)
  
  // Who can access this? Map for O(1) permission checks.
  // Key: user_uid, Value: UserRole
  access_list: Record<string, UserRole>; 
  
  settings?: {
    allow_video?: boolean;
    // Add future config toggles here
  };
  created_at: string;
}

// The Invite Code Document
// Collection: invites
export interface Invite {
  code: string;          // The lookup key (e.g. "XC9-22M")
  target_explorer_id: string;
  created_by: string;    // uid of the person who generated the invite
  role: UserRole;        // What role will the new user get?
  status: 'active' | 'used' | 'expired';
  expires_at: string;
}