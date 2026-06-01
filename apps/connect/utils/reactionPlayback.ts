import { API_ENDPOINTS, Event, EventMetadata, ExplorerConfig, getAvatarColor, getAvatarInitial, type ReactionType } from '@projectmirror/shared';
import type { CompanionAvatar } from '@projectmirror/shared';
import {
  arrayRemove,
  collection,
  db,
  deleteDoc,
  doc,
  getDocs,
  limit,
  query,
  updateDoc,
  where,
} from '@projectmirror/shared/firebase';

/** Parent Reflection volume during Live Sync recording on speaker when Original audio is on.
 *  Companions should keep Original audio off on speaker to avoid echo in the recording. */
export const REACTION_PARENT_RECORDING_VOLUME = 0.40;

/** Parent Reflection volume during recording when headphones/Bluetooth are connected. There is no
 *  acoustic echo path, so the Companion can hear the Reflection at full volume while recording. */
export const REACTION_PARENT_HEADPHONES_VOLUME = 1.0;

/** Parent Reflection volume during timeline reaction replay (viewing experience). */
export const REACTION_PARENT_PLAYBACK_VOLUME = 0.15;

/** Audio conditions captured when a selfie reaction finishes recording. */
export type SelfieRecordingAudioSnapshot = {
  originalAudioMuted: boolean;
  hasHeadphones: boolean;
};

/**
 * Whether companion/timeline preview should mix in a separate parent audio track.
 * When Original audio played on the speaker, parent bleed may be baked into the selfie file —
 * adding 15% parent again sounds like echo.
 */
export function shouldPlaySeparateParentInPreview(
  snapshot: SelfieRecordingAudioSnapshot,
): boolean {
  if (snapshot.originalAudioMuted) return true;
  if (snapshot.hasHeadphones) return true;
  return false;
}

export function resolveCompanionPreviewParentVolume(
  snapshot: SelfieRecordingAudioSnapshot,
): number {
  return shouldPlaySeparateParentInPreview(snapshot)
    ? REACTION_PARENT_PLAYBACK_VOLUME
    : 0;
}

/**
 * Resolves the parent Reflection volume to use while recording a reaction.
 *
 * Instagram-style "Original audio" mix: the video always plays for visual sync, but whether its
 * audio is audible depends on capability. Headphones → full volume. Speaker → off by default
 * (Companion can opt in; expect echo). Muted → silent.
 */
export function resolveReactionRecordingVolume(options: {
  muted: boolean;
  hasHeadphones: boolean;
}): number {
  if (options.muted) return 0;
  return options.hasHeadphones ? REACTION_PARENT_HEADPHONES_VOLUME : REACTION_PARENT_RECORDING_VOLUME;
}

/**
 * Whether the parent Reflection's audio ("Original audio") should default to ON for the current
 * audio route.
 *
 * Headphones / Bluetooth only — no speaker echo path. On the built-in speaker we default OFF until
 * the Companion opts in.
 */
export function defaultReactionOriginalAudioEnabled(options: {
  hasHeadphones: boolean;
}): boolean {
  return options.hasHeadphones;
}

export type ReactionResponderFace = {
  key: string;
  userId: string;
  companionName: string;
  avatarUrl: string | null;
  color: string;
  initial: string;
  reactionType?: ReactionType;
};

export type SentReflectionReactionFields = {
  respondedRelationshipIds?: string[];
  respondedCompanionIds?: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const asOptionalString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

export function timestampToISO(ts: unknown): string {
  if (!ts) return new Date().toISOString();
  if (typeof ts === 'object' && ts !== null && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString();
  }
  if (typeof ts === 'object' && ts !== null && typeof (ts as { seconds?: number }).seconds === 'number') {
    const s = ts as { seconds: number; nanoseconds?: number };
    return new Date(s.seconds * 1000 + (s.nanoseconds || 0) / 1_000_000).toISOString();
  }
  if (typeof ts === 'number') return new Date(ts).toISOString();
  if (typeof ts === 'string') return ts;
  return new Date(ts as string | number).toISOString();
}

export function coerceEmbeddedMetadata(raw: unknown, fallbackEventId: string): EventMetadata | undefined {
  if (!isRecord(raw)) return undefined;
  const o = raw;
  const description = typeof o.description === 'string' ? o.description : '';
  const shortCaption = typeof o.short_caption === 'string' ? o.short_caption : '';
  const sender = typeof o.sender === 'string' ? o.sender : '';
  if (!description && !shortCaption && !sender) return undefined;

  let timestamp: string;
  const ts = o.timestamp;
  if (typeof ts === 'string') {
    timestamp = ts;
  } else if (ts && typeof ts === 'object' && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    timestamp = (ts as { toDate: () => Date }).toDate().toISOString();
  } else {
    timestamp = new Date().toISOString();
  }

  const event_id =
    typeof o.event_id === 'string' && o.event_id.length > 0 ? o.event_id : fallbackEventId;
  const meta: EventMetadata = {
    description: description || shortCaption || 'Reflection',
    sender: sender || 'Companion',
    timestamp,
    event_id,
  };
  if (typeof o.sender_id === 'string' && o.sender_id) meta.sender_id = o.sender_id;
  if (o.content_type === 'text' || o.content_type === 'audio' || o.content_type === 'video') {
    meta.content_type = o.content_type;
  }
  if (shortCaption) meta.short_caption = shortCaption;
  if (typeof o.deep_dive === 'string' && o.deep_dive) meta.deep_dive = o.deep_dive;
  return meta;
}

export function resolveReactionResponderFaces(
  item: SentReflectionReactionFields,
  companionByRelationshipId: Map<string, CompanionAvatar>,
  companionByUserId: Map<string, CompanionAvatar>,
): ReactionResponderFace[] {
  const relationshipIds = item.respondedRelationshipIds ?? [];
  if (relationshipIds.length > 0) {
    return relationshipIds.map((relationshipId) => {
      const companion = companionByRelationshipId.get(relationshipId);
      return {
        key: relationshipId,
        userId: companion?.userId ?? relationshipId,
        companionName: companion?.companionName ?? 'Companion',
        avatarUrl: companion?.avatarUrl ?? null,
        color: companion?.color ?? getAvatarColor(relationshipId),
        initial: companion?.initial ?? getAvatarInitial(companion?.companionName ?? 'Companion'),
      };
    });
  }

  const legacyUids = item.respondedCompanionIds ?? [];
  return legacyUids.map((uid) => {
    const companion = companionByUserId.get(uid);
    return {
      key: uid,
      userId: uid,
      companionName: companion?.companionName ?? 'Companion',
      avatarUrl: companion?.avatarUrl ?? null,
      color: companion?.color ?? getAvatarColor(uid),
      initial: companion?.initial ?? getAvatarInitial(companion?.companionName ?? 'Companion'),
    };
  });
}

export async function fetchMirrorEventById(
  eventId: string,
  explorerId: string,
  eventObjectsMap?: Map<string, Event>,
): Promise<Event | null> {
  let fullEvent = eventObjectsMap?.get(eventId);
  if (!fullEvent) {
    try {
      const eventsResponse = await fetch(`${API_ENDPOINTS.LIST_MIRROR_EVENTS}?explorer_id=${explorerId}`);
      if (eventsResponse.ok) {
        const eventsData = await eventsResponse.json().catch(() => null);
        const events = isRecord(eventsData) && Array.isArray(eventsData?.events) ? eventsData.events : [];
        const matchingEvent = events
          .filter(Boolean)
          .find((e) => (e as Event)?.event_id === eventId) as Event | undefined;
        if (matchingEvent) {
          fullEvent = matchingEvent;
        }
      }
    } catch (err) {
      console.error('Error fetching event for replay:', err);
    }
  }
  return fullEvent ?? null;
}

export function buildEventForReplay(
  eventId: string,
  options: {
    metadata?: EventMetadata;
    reflectionImageUrl?: string;
    senderLabel?: string;
    sentTimestamp?: unknown;
    timestamp?: unknown;
    description?: string;
    fullEvent?: Event | null;
    isReaction?: boolean;
    parentReflectionId?: string | null;
    syncStartTimeMillis?: number;
    reactionType?: ReactionType;
  },
): Event {
  const metadata = options.metadata ?? (options.fullEvent?.metadata as EventMetadata | undefined);
  const isReaction = options.isReaction === true;
  const description = isReaction
    ? metadata?.reaction_message || metadata?.description || ''
    : options.description || metadata?.description || metadata?.short_caption || 'Reflection';
  return {
    event_id: eventId,
    image_url:
      asOptionalString(options.fullEvent?.image_url) ??
      asOptionalString(options.reflectionImageUrl) ??
      '',
    audio_url: options.fullEvent?.audio_url,
    video_url: options.fullEvent?.video_url,
    deep_dive_audio_url: options.fullEvent?.deep_dive_audio_url,
    ...(isReaction ? { isReaction: true } : {}),
    ...(options.parentReflectionId ? { parentReflectionId: options.parentReflectionId } : {}),
    ...(typeof options.syncStartTimeMillis === 'number'
      ? { syncStartTimeMillis: options.syncStartTimeMillis }
      : {}),
    ...(options.reactionType ? { reactionType: options.reactionType } : {}),
    ...(options.fullEvent?.reactionType && !options.reactionType
      ? { reactionType: options.fullEvent.reactionType }
      : {}),
    metadata: metadata
      ? {
          ...metadata,
          event_id: eventId,
          description: isReaction ? metadata.description || description : metadata.description || description,
          ...(isReaction
            ? {}
            : { short_caption: metadata.short_caption || description }),
        }
      : isReaction
        ? {
            description,
            sender: options.senderLabel || 'Companion',
            timestamp: timestampToISO(options.sentTimestamp || options.timestamp),
            event_id: eventId,
          }
        : {
            description,
            sender: options.senderLabel || 'Companion',
            timestamp: timestampToISO(options.sentTimestamp || options.timestamp),
            event_id: eventId,
            short_caption: description,
          },
  };
}

export async function fetchReactionEventForPlayback(
  parentEventId: string,
  face: ReactionResponderFace,
  explorerId: string,
  eventObjectsMap?: Map<string, Event>,
): Promise<Event | null> {
  const reactionsQuery = query(
    collection(db, ExplorerConfig.collections.reflections),
    where('parentReflectionId', '==', parentEventId),
    where('isReaction', '==', true),
    limit(20),
  );
  const snap = await getDocs(reactionsQuery);
  const matchDoc = snap.docs.find((reactionDoc) => {
    const data = reactionDoc.data();
    if (data?.responderRelationshipId === face.key) return true;
    return data?.sender_id === face.userId;
  });

  if (!matchDoc) {
    return null;
  }

  const data = matchDoc.data();
  const reactionEventId = asOptionalString(data?.event_id) ?? matchDoc.id;
  const metadata = coerceEmbeddedMetadata(data?.metadata, reactionEventId);
  const sender =
    metadata?.sender || asOptionalString(data?.sender) || face.companionName;
  const senderId = asOptionalString(data?.sender_id) ?? face.userId;
  const fullEvent = await fetchMirrorEventById(reactionEventId, explorerId, eventObjectsMap);
  const syncStartTimeMillis =
    typeof data?.syncStartTimeMillis === 'number'
      ? data.syncStartTimeMillis
      : typeof fullEvent?.syncStartTimeMillis === 'number'
        ? fullEvent.syncStartTimeMillis
        : undefined;
  const reactionType = coerceReactionType(
    data?.reactionType ?? fullEvent?.reactionType,
    fullEvent,
    metadata,
  );

  return buildEventForReplay(reactionEventId, {
    metadata: metadata
      ? {
          ...metadata,
          event_id: reactionEventId,
          sender: metadata.sender || sender,
          sender_id: metadata.sender_id || senderId,
        }
      : undefined,
    senderLabel: sender,
    timestamp: data?.timestamp,
    description: metadata?.short_caption || metadata?.description,
    fullEvent,
    isReaction: data?.isReaction === true || fullEvent?.isReaction === true,
    parentReflectionId: asOptionalString(data?.parentReflectionId) ?? parentEventId,
    syncStartTimeMillis,
    reactionType,
  });
}

function coerceReactionType(raw: unknown, fullEvent: Event | null, metadata?: EventMetadata): ReactionType {
  if (raw === 'selfie' || raw === 'typed' || raw === 'voice') {
    return raw;
  }
  if (metadata?.reaction_message) {
    return 'typed';
  }
  if (fullEvent?.video_url) return 'selfie';
  if (fullEvent?.audio_url || metadata?.content_type === 'audio') return 'voice';
  return 'selfie';
}

export async function fetchReactionTypesByRelationship(
  parentEventId: string,
): Promise<Map<string, ReactionType>> {
  const reactionsQuery = query(
    collection(db, ExplorerConfig.collections.reflections),
    where('parentReflectionId', '==', parentEventId),
    where('isReaction', '==', true),
    limit(20),
  );
  const snap = await getDocs(reactionsQuery);
  const map = new Map<string, ReactionType>();
  for (const reactionDoc of snap.docs) {
    const data = reactionDoc.data();
    const metadata = coerceEmbeddedMetadata(data?.metadata, reactionDoc.id);
    const relationshipId = asOptionalString(data?.responderRelationshipId);
    if (!relationshipId) continue;
    map.set(
      relationshipId,
      coerceReactionType(data?.reactionType, null, metadata),
    );
  }
  return map;
}

export type ReactionPlaybackSession = {
  parentEventId: string;
  parentAuthorName: string;
  parentEvent: Event;
  respondedRelationshipIds: string[];
};

export type ReactionParentPipMedia =
  | { mediaType: 'video'; url: string }
  | { mediaType: 'image'; url: string };

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

export function resolveReactionResponderFaceForPlayback(
  event: Event | null | undefined,
  options: {
    companionByRelationshipId: Map<string, CompanionAvatar>;
    companionByUserId: Map<string, CompanionAvatar>;
    activeFaceKey?: string | null;
    responderFaces?: ReactionResponderFace[];
    reactionType?: ReactionType;
  },
): ReactionResponderFace | null {
  const { companionByRelationshipId, companionByUserId, activeFaceKey, responderFaces, reactionType } =
    options;

  if (activeFaceKey && responderFaces?.length) {
    const matched = responderFaces.find((face) => face.key === activeFaceKey);
    if (matched) return matched;
  }

  const senderId = asOptionalString(event?.metadata?.sender_id);
  if (senderId) {
    const companion = companionByUserId.get(senderId);
    if (companion) {
      return {
        key: companion.relationshipId,
        userId: companion.userId,
        companionName: companion.companionName,
        avatarUrl: companion.avatarUrl,
        color: companion.color,
        initial: companion.initial,
        reactionType,
      };
    }
    return {
      key: senderId,
      userId: senderId,
      companionName: event?.metadata?.sender || 'Companion',
      avatarUrl: null,
      color: getAvatarColor(senderId),
      initial: getAvatarInitial(event?.metadata?.sender || 'Companion'),
      reactionType,
    };
  }

  const relationshipId = asOptionalString(
    (event as { responderRelationshipId?: string } | null | undefined)?.responderRelationshipId,
  );
  if (relationshipId) {
    const companion = companionByRelationshipId.get(relationshipId);
    if (companion) {
      return {
        key: companion.relationshipId,
        userId: companion.userId,
        companionName: companion.companionName,
        avatarUrl: companion.avatarUrl,
        color: companion.color,
        initial: companion.initial,
        reactionType,
      };
    }
  }

  return null;
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

export async function deleteReflectionDocument(
  eventId: string,
  explorerId: string,
): Promise<void> {
  const deleteRes = await fetch(
    `${API_ENDPOINTS.DELETE_MIRROR_EVENT}?event_id=${eventId}&explorer_id=${explorerId}&path=to`,
    { method: 'DELETE' },
  );
  if (!deleteRes.ok) {
    const errData = await deleteRes.json().catch(() => null);
    const errors =
      isRecord(errData) && Array.isArray(errData?.errors)
        ? errData.errors.filter((e): e is string => typeof e === 'string')
        : [];
    throw new Error(errors.join(', ') || 'Failed to delete reflection');
  }

  await deleteDoc(doc(db, ExplorerConfig.collections.reflections, eventId));
}

export async function removeResponderFromParentReflection(
  parentReflectionId: string,
  relationshipId: string,
): Promise<void> {
  await updateDoc(doc(db, ExplorerConfig.collections.reflections, parentReflectionId), {
    respondedRelationshipIds: arrayRemove(relationshipId),
  });
}
