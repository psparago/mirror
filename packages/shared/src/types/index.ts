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
  /** Typed reaction message (display only; spoken via audio_url). */
  reaction_message?: string;
  /** True when this image Reflection has a Bring-It-to-Life selfie narration child doc. */
  has_narration?: boolean;
  /** Event id of the Bring-It-to-Life narration child doc. */
  narration_event_id?: string;
  /** Playback trim: inclusive start time in milliseconds (video). */
  video_start_ms?: number;
  /** Playback trim: exclusive or inclusive end boundary in milliseconds (video); pair with `video_start_ms`. */
  video_end_ms?: number;
  /** Poster frame position within the source video, in milliseconds. */
  thumbnail_time_ms?: number;
  /** Encoded video width in pixels, captured after upload normalization when known. */
  video_width?: number;
  /** Encoded video height in pixels, captured after upload normalization when known. */
  video_height?: number;
  /** Rotation metadata in degrees, when known. Prefer normalized uploads with 0/undefined. */
  video_rotation_degrees?: number;
}

export type ReactionType = 'selfie' | 'typed' | 'voice';

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
  /** True when this event is a Companion reaction recording. */
  isReaction?: boolean;
  /** Parent Reflection id for reaction playback alignment. */
  parentReflectionId?: string | null;
  /** Parent playhead (ms) when the reaction recording started. */
  syncStartTimeMillis?: number;
  /** Companion reaction capture mode. */
  reactionType?: ReactionType;
  /** True when this reaction is the author's narration of an image Reflection (not a response). */
  isNarration?: boolean;
  /** True when this image Reflection has a Bring-It-to-Life selfie narration child doc. */
  has_narration?: boolean;
  /** Event id of the Bring-It-to-Life narration child doc. */
  narration_event_id?: string;
}

/** Merged Firestore signal doc (`mirror_event` + engagement overlays); rich content lives in `metadata`. */
export interface ReflectionDocument {
  explorerId: string;
  event_id: string;
  sender?: string;
  sender_id?: string;
  status?: 'ready' | 'engaged' | 'replayed' | 'deleted';
  timestamp?: unknown;
  type?: 'mirror_event' | 'engagement_heartbeat' | string;
  metadata?: EventMetadata;
  engagement_count?: number;
  deleted_at?: unknown;
  likedBy?: string[]; // UIDs that liked this Reflection.
  /** True when this document is a Companion reaction to another Reflection. */
  isReaction?: boolean;
  /** Firestore ID of the parent Reflection being replied to. */
  parentReflectionId?: string | null;
  /** `relationships/{id}` for the Companion who recorded this reaction. */
  responderRelationshipId?: string;
  /** Companion reaction capture mode (e.g. live-sync selfie). */
  reactionType?: ReactionType;
  /** True when this reaction is the author's narration of an image Reflection (not a response). */
  isNarration?: boolean;
  /** True when this image Reflection has a Bring-It-to-Life selfie narration child doc. */
  has_narration?: boolean;
  /** Event id of the Bring-It-to-Life narration child doc. */
  narration_event_id?: string;
  /** Parent Reflection playhead (ms) when the reaction recording started. */
  syncStartTimeMillis?: number;
  /**
   * `relationships/{id}` doc ids for Companions who reacted to this parent (per Explorer link).
   * Prefer this over `respondedCompanionIds` — one Firebase user can have multiple Explorer relationships.
   */
  respondedRelationshipIds?: string[];
  /** @deprecated Legacy writes used Firebase Auth UIDs; read for backward compatibility only. */
  respondedCompanionIds?: string[];
}

export type PendingNotificationTriggerType =
  | 'companion_upload'
  | 'companion_reaction'
  | 'explorer_like'
  | 'companion_like';
export type PendingNotificationStatus = 'pending';

// Collection: system_config
// Document ID: explorerId
export interface SystemConfigDocument {
  debounce_minutes: number;
  /** Legacy explorer default; per-companion prefs override via users.upload_digest_*. */
  min_hours_between_digests: number;
  explorer_like_delay_seconds: number;
}

// Collection: pending_notifications
export interface PendingNotificationDocument {
  explorerId: string;
  broadcastToAllCompanions: boolean;
  recipientIds: string[];
  triggerType: PendingNotificationTriggerType;
  reflectionId: string;
  parentReflectionId?: string;
  parentReflectionAuthorName?: string;
  senderName: string;
  likerId?: string;
  likerName?: string;
  status: PendingNotificationStatus;
  createdAt: unknown;
}

export interface ListEventsResponse {
  events: Event[];
}

export type UserRole = 'owner' | 'admin' | 'contributor';

// Represents the link between a Companion and an Explorer
export interface ExplorerConnection {
  explorer_id: string;
  role: UserRole;
  nickname?: string; // e.g. "Explorer" - What the companion calls this explorer locally
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
  developer_tools_enabled?: boolean;
  push_notifications_enabled?: boolean;
  /** Slow-lane digest when others share Reflections. Default: batched. */
  upload_digest_mode?: 'off' | 'soon' | 'batched';
  /** Hours between batched digests when mode is batched. Default: 2. */
  upload_digest_hours?: number;
  /** Server push when a Companion has not shared in 7 days. Default: true. */
  posting_reminders_enabled?: boolean;
}

// The Explorer (Device/Context) Document
// Collection: explorers
export interface Explorer {
  explorer_id: string;   // Unique ID (e.g. "explorer_mirror_01")
  name: string;          // e.g. "Explorer's Reflection" (System name)
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