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
  sender_id?: string; // Firebase userId of the companion who sent this reflection
  timestamp: string;
  event_id: string;
  // Note: audio_url/video_url are NOT stored in metadata.json (presigned URLs expire)
  // The backend ListMirrorEvents generates fresh presigned GET URLs in the Event object
  content_type?: 'text' | 'audio' | 'video';
  image_source?: 'camera' | 'search' | 'gallery'; // Where the image came from (legacy UI)
  // AI-generated dual-story fields
  short_caption?: string; // Brief greeting - auto-played on load
  deep_dive?: string; // Detailed story - played when ✨ is tapped
  deep_dive_audio_url?: string; // Optional TTS for deep dive
  // Narrative context captured during creation/edit flow (legacy mirrors below)
  companion_in_reflection?: boolean;
  explorer_in_reflection?: boolean;
  people_context?: string;
  // Search provenance for image reflections
  search_query?: string;
  search_canonical_name?: string;
  /** Library asset id (e.g. Unsplash photo id). */
  library_id?: string;
  /** Where the media was chosen from (canonical provenance). */
  library_source?: 'unsplash' | 'camera' | 'gallery';
  /** Search term used when picking from a library (e.g. Unsplash query). */
  library_search_term?: string;
  /** Companion visible in the reflection (default false when absent). */
  is_companion_present?: boolean;
  /** Explorer visible in the reflection (default false when absent). */
  is_explorer_present?: boolean;
  /** True when this reflection is primarily an Explorer selfie capture. */
  is_selfie?: boolean;
  /** Free-form people / scene hints (preferred over legacy `people_context` when both exist). */
  people_context_hints?: string;
  /** ISO timestamp when a Companion last saved edits to this reflection (metadata and/or media). */
  last_edited_at?: string;
  /** Playback trim: inclusive start time in milliseconds (video). */
  video_start_ms?: number;
  /** Playback trim: exclusive or inclusive end boundary in milliseconds (video); pair with `video_start_ms`. */
  video_end_ms?: number;
  /** Poster frame position within the source video, in milliseconds. */
  thumbnail_time_ms?: number;
}

export interface Event {
  event_id: string;
  image_url: string; // Always a JPG/PNG (Thumbnail for video events)
  metadata_url?: string;
  audio_url?: string; // Optional presigned GET URL for audio.m4a
  video_url?: string; // Optional presigned GET URL for video.mp4
  deep_dive_audio_url?: string; // Optional presigned GET URL for deep_dive.m4a
  /** Inline bundle (e.g. from Firestore); when set, Explorer can skip S3 metadata.json fetch. */
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
    autoplay?: boolean;
  };
  explorerAvatarS3Key?: string; // S3 key for the Explorer's profile photo
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