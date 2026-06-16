import type { CompanionAvatar } from '../hooks/useCompanionAvatars';
import type { Event, EventMetadata, ReactionType } from '../types';
import { getAvatarColor, getAvatarInitial } from '../utils/avatarDefaults';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DocumentaryChapter {
  /** 0 = base Reflection author; 1…n = Companion reactions in chronological order. */
  index: number;
  event: Event;
  metadata: EventMetadata | null;
  /** Display name for this chapter's speaker. */
  speakerName: string;
  /** Avatar image URL, or null to use initials. */
  speakerAvatarUrl: string | null;
  /** Fallback avatar colour. */
  speakerColor: string;
  /** Single uppercase initial. */
  speakerInitial: string;
  /** Reaction type; null for the base chapter. */
  reactionType: ReactionType | null;
  /** True for chapters 1…n. */
  isReaction: boolean;
}

export interface ReactionSignal {
  eventId: string;
  parentReflectionId: string;
  /** Unix ms derived from event_id or Firestore timestamp. */
  timestampMs: number;
  isNarration: boolean;
  responderRelationshipId?: string;
  respondedRelationshipIds?: string[];
}

// ---------------------------------------------------------------------------
// Chapter builder
// ---------------------------------------------------------------------------

/**
 * Build an ordered list of documentary chapters for the given parent Reflection.
 *
 * Chapter 0 is always the base Reflection itself.
 * Chapters 1…n are the Companion reactions, sorted chronologically (oldest first),
 * with `isNarration` reactions excluded.
 */
export function buildDocumentaryChapters(
  parentEvent: Event,
  reactionEvents: Event[],
  metadataMap: Record<string, EventMetadata>,
  companions: CompanionAvatar[],
): DocumentaryChapter[] {
  const companionByUserId = new Map(companions.map((c) => [c.userId, c]));
  const companionByRelationshipId = new Map(companions.map((c) => [c.relationshipId, c]));

  const parentMeta = parentEvent.metadata ?? metadataMap[parentEvent.event_id] ?? null;
  const parentSenderId = parentMeta?.sender_id ?? null;
  const parentSenderName = parentMeta?.sender ?? 'Companion';

  const authorCompanion = parentSenderId ? companionByUserId.get(parentSenderId) : null;

  const baseChapter: DocumentaryChapter = {
    index: 0,
    event: parentEvent,
    metadata: parentMeta,
    speakerName: authorCompanion?.companionName ?? parentSenderName,
    speakerAvatarUrl: authorCompanion?.avatarUrl ?? null,
    speakerColor: authorCompanion?.color ?? (parentSenderId ? getAvatarColor(parentSenderId) : '#444'),
    speakerInitial: authorCompanion?.initial ?? getAvatarInitial(parentSenderName),
    reactionType: null,
    isReaction: false,
  };

  // Sort reactions chronologically by event_id (numeric timestamp prefix) then fallback
  const sortedReactions = [...reactionEvents]
    .filter((e) => !e.isNarration)
    .sort((a, b) => {
      const ta = parseInt(a.event_id, 10);
      const tb = parseInt(b.event_id, 10);
      if (!isNaN(ta) && !isNaN(tb)) return ta - tb;
      return a.event_id.localeCompare(b.event_id);
    });

  const reactionChapters: DocumentaryChapter[] = sortedReactions.map((reactionEvent, i) => {
    const meta = reactionEvent.metadata ?? metadataMap[reactionEvent.event_id] ?? null;
    const senderId = meta?.sender_id ?? null;
    const senderName = meta?.sender ?? 'Companion';

    // Resolve companion via sender_id, then try to find by relationship if metadata carries it
    const companion = senderId
      ? (companionByUserId.get(senderId) ?? null)
      : null;

    // Fallback: check if the event carries a responderRelationshipId
    const relationshipId = (reactionEvent as Event & { responderRelationshipId?: string })
      .responderRelationshipId;
    const companionByRel = relationshipId
      ? (companionByRelationshipId.get(relationshipId) ?? null)
      : null;

    const resolved = companion ?? companionByRel;

    const reactionType = resolveReactionType(reactionEvent, meta);

    return {
      index: i + 1,
      event: reactionEvent,
      metadata: meta,
      speakerName: resolved?.companionName ?? senderName,
      speakerAvatarUrl: resolved?.avatarUrl ?? null,
      speakerColor: resolved?.color ?? (senderId ? getAvatarColor(senderId) : '#444'),
      speakerInitial: resolved?.initial ?? getAvatarInitial(senderName),
      reactionType,
      isReaction: true,
    };
  });

  return [baseChapter, ...reactionChapters];
}

// ---------------------------------------------------------------------------
// Subtitle text
// ---------------------------------------------------------------------------

/**
 * Derive up to 2 lines of subtitle ribbon text for the active chapter.
 * Returns null when there is nothing useful to display.
 */
export function resolveChapterSubtitle(chapter: DocumentaryChapter): string | null {
  const meta = chapter.metadata;
  if (!chapter.isReaction) {
    // Base chapter: prefer short_caption, then description
    return trimToSubtitle(meta?.short_caption) ?? trimToSubtitle(meta?.description) ?? null;
  }

  // Reaction chapters
  switch (chapter.reactionType) {
    case 'typed': {
      const message = trimToSubtitle(meta?.reaction_message);
      if (message) {
        return `${chapter.speakerName}: "${message}"`;
      }
      return chapter.speakerName;
    }
    case 'voice':
      return chapter.speakerName;
    case 'selfie':
      return chapter.speakerName;
    default:
      return chapter.speakerName;
  }
}

function trimToSubtitle(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Deep Dive gate
// ---------------------------------------------------------------------------

/**
 * Deep Dive applies to the base Reflection (chapter 0) only — not reaction chapters.
 */
export function shouldBypassDeepDive(chapterIndex: number): boolean {
  return chapterIndex > 0;
}

// ---------------------------------------------------------------------------
// Reaction type resolution
// ---------------------------------------------------------------------------

function resolveReactionType(event: Event, meta: EventMetadata | null): ReactionType {
  if (event.reactionType === 'selfie' || event.reactionType === 'typed' || event.reactionType === 'voice') {
    return event.reactionType;
  }
  if (meta?.reaction_message) return 'typed';
  if (event.video_url) return 'selfie';
  if (event.audio_url) return 'voice';
  return 'selfie';
}
