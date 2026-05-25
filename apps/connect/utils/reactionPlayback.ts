import { API_ENDPOINTS, Event, EventMetadata, ExplorerConfig, getAvatarColor, getAvatarInitial } from '@projectmirror/shared';
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

export type ReactionResponderFace = {
  key: string;
  userId: string;
  companionName: string;
  avatarUrl: string | null;
  color: string;
  initial: string;
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
  },
): Event {
  const metadata = options.metadata ?? (options.fullEvent?.metadata as EventMetadata | undefined);
  const description =
    options.description || metadata?.description || metadata?.short_caption || 'Reflection';
  return {
    event_id: eventId,
    image_url:
      asOptionalString(options.fullEvent?.image_url) ??
      asOptionalString(options.reflectionImageUrl) ??
      '',
    audio_url: options.fullEvent?.audio_url,
    video_url: options.fullEvent?.video_url,
    deep_dive_audio_url: options.fullEvent?.deep_dive_audio_url,
    metadata: metadata
      ? {
          ...metadata,
          event_id: eventId,
          description: metadata.description || description,
          short_caption: metadata.short_caption || description,
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
  });
}

export type ReactionPlaybackSession = {
  parentEventId: string;
  parentAuthorName: string;
  parentEvent: Event;
  respondedRelationshipIds: string[];
};

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
