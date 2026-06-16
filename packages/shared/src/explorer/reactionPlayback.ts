import type { Event, ReactionType } from '../types';

/** Parent Reflection volume when reaction audio/video is primary. */
export const REACTION_PARENT_PLAYBACK_VOLUME = 0.08;

export type ReactionParentPipMedia =
  | { mediaType: 'video'; url: string }
  | { mediaType: 'image'; url: string };

function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function resolveReactionPlaybackType(event: Event | null | undefined): ReactionType {
  if (event?.reactionType === 'selfie' || event?.reactionType === 'typed' || event?.reactionType === 'voice') {
    return event.reactionType;
  }
  if (event?.video_url) return 'selfie';
  if (event?.audio_url) return 'voice';
  return 'selfie';
}

/** Typed and voice reactions show the responding Companion's avatar in PiP. */
export function shouldUseCompanionAvatarReactionPip(reactionType: ReactionType): boolean {
  return reactionType === 'typed' || reactionType === 'voice';
}

export function resolveReactionParentPipMedia(
  event: Event | null | undefined,
  options?: { preferImage?: boolean },
): ReactionParentPipMedia | null {
  const imageUrl = asOptionalString(event?.image_url);
  const videoUrl = asOptionalString(event?.video_url);
  if (options?.preferImage && imageUrl) {
    return { mediaType: 'image', url: imageUrl };
  }
  if (videoUrl) {
    return { mediaType: 'video', url: videoUrl };
  }
  if (imageUrl) {
    return { mediaType: 'image', url: imageUrl };
  }
  return null;
}
