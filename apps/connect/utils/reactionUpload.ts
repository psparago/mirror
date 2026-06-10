import { ensureFileUri, prepareImageForUpload } from '@/utils/mediaProcessor';
import { formatTypedReactionSpeechText } from '@/utils/reactionPlayback';
import { loadVoicePreferences } from '@/utils/ttsVoices';
import { diagnosticsAppLog } from '@/utils/diagnosticsLog';
import { API_ENDPOINTS, EventMetadata, ExplorerConfig, type ReactionType } from '@projectmirror/shared';
import {
  arrayUnion,
  collection,
  db,
  doc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from '@projectmirror/shared/firebase';
import * as FileSystem from 'expo-file-system';
import * as VideoThumbnails from 'expo-video-thumbnails';

const FALLBACK_POSTER_REMOTE_URL =
  'https://dummyimage.com/640x640/1f2937/e5e7eb.jpg&text=Reaction';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const asOptionalString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const parseJsonRecord = async (response: Response): Promise<Record<string, unknown> | null> => {
  const json = await response.json().catch(() => null);
  return isRecord(json) ? json : null;
};

async function safeUploadToS3(localUri: string, presignedUrl: string): Promise<void> {
  let uriToUpload = localUri;
  let tempUri: string | null = null;

  if (localUri.startsWith('http')) {
    const urlPath = localUri.split('?')[0];
    const lastSegment = urlPath.split('/').pop() || '';
    const dotParts = lastSegment.split('.');
    const extractedExt = dotParts.length > 1 ? dotParts.pop()?.toLowerCase() : null;
    const extension =
      extractedExt && extractedExt.length <= 4 && !extractedExt.includes('/') ? extractedExt : 'jpg';
    const filename = `reaction_upload_${Date.now()}_${Math.floor(Math.random() * 1000)}.${extension}`;
    const downloadRes = await FileSystem.downloadAsync(
      localUri,
      `${FileSystem.cacheDirectory}${filename}`,
    );
    uriToUpload = downloadRes.uri;
    tempUri = downloadRes.uri;
  }

  try {
    const extension = uriToUpload.split('.').pop()?.toLowerCase();
    const contentType =
      extension === 'png'
        ? 'image/png'
        : extension === 'webp'
          ? 'image/webp'
          : extension === 'm4a' || extension === 'caf'
            ? 'audio/mp4'
            : extension === 'mp3'
              ? 'audio/mpeg'
              : 'image/jpeg';
    const uploadResult = await FileSystem.uploadAsync(presignedUrl, uriToUpload, {
      httpMethod: 'PUT',
      headers: { 'Content-Type': contentType },
    });
    if (uploadResult.status !== 200) {
      throw new Error(`Upload failed with status ${uploadResult.status}`);
    }
  } finally {
    if (tempUri) {
      await FileSystem.deleteAsync(tempUri, { idempotent: true }).catch(() => {});
    }
  }
}

async function extractReactionPosterUri(recordedUri: string): Promise<string> {
  try {
    const { uri } = await VideoThumbnails.getThumbnailAsync(ensureFileUri(recordedUri), {
      time: 0,
      quality: 0.5,
    });
    return prepareImageForUpload(uri);
  } catch (error) {
    console.warn('[reactionUpload] thumbnail extraction failed; using fallback poster', error);
    return FALLBACK_POSTER_REMOTE_URL;
  }
}

async function resolvePosterUri(
  reactionType: ReactionType,
  options: {
    recordedVideoUri?: string;
    parentPosterUri?: string;
  },
): Promise<string> {
  if (reactionType === 'selfie' && options.recordedVideoUri) {
    return extractReactionPosterUri(options.recordedVideoUri);
  }
  if (options.parentPosterUri) {
    if (options.parentPosterUri.startsWith('http')) {
      return options.parentPosterUri;
    }
    return prepareImageForUpload(options.parentPosterUri);
  }
  return FALLBACK_POSTER_REMOTE_URL;
}

export async function generateTypedReactionAudio(
  messageText: string,
  explorerId: string,
  captionVoice: string,
  companionName?: string,
): Promise<string> {
  const spokenText = companionName
    ? formatTypedReactionSpeechText(companionName, messageText)
    : messageText.trim();
  const params = new URLSearchParams({
    explorer_id: explorerId,
    target_caption: spokenText,
    target_deep_dive: spokenText,
    caption_voice: captionVoice,
  });
  const response = await fetch(`${API_ENDPOINTS.AI_DESCRIPTION}?${params.toString()}`);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`TTS generation failed: ${response.status} ${errorText}`);
  }
  const json = await parseJsonRecord(response);
  const audioUrl = asOptionalString(json?.audio_url);
  if (!audioUrl) {
    throw new Error('TTS generation returned no audio URL');
  }
  const localPath = `${FileSystem.cacheDirectory}reaction_tts_${Date.now()}.mp3`;
  const download = await FileSystem.downloadAsync(audioUrl, localPath);
  return download.uri;
}

export type UploadReactionParams = {
  reactionType: ReactionType;
  explorerId: string;
  parentReflectionId: string;
  syncStartTimeMillis: number;
  senderName: string;
  senderId: string;
  activeRelationshipId: string;
  recordedVideoUri?: string;
  messageText?: string;
  recordedAudioUri?: string;
  parentPosterUri?: string;
  /**
   * Author's narration of their own image Reflection. Stored as a flagged child
   * reaction; does not mark the parent as responded-to.
   */
  isNarration?: boolean;
};

export async function uploadReaction({
  reactionType,
  explorerId,
  parentReflectionId,
  syncStartTimeMillis,
  senderName,
  senderId,
  activeRelationshipId,
  recordedVideoUri,
  messageText,
  recordedAudioUri,
  parentPosterUri,
  isNarration = false,
}: UploadReactionParams): Promise<string> {
  if (reactionType === 'selfie' && !recordedVideoUri) {
    throw new Error('Selfie reaction requires a recorded video');
  }
  if (reactionType === 'typed' && !messageText?.trim()) {
    throw new Error('Typed reaction requires a message');
  }
  if (reactionType === 'voice' && !recordedAudioUri) {
    throw new Error('Voice reaction requires a recorded audio clip');
  }

  diagnosticsAppLog('reactionUpload', 'upload:start', {
    reactionType,
    platform: 'connect',
  });

  const eventID = Date.now().toString();
  const filesToSign =
    reactionType === 'selfie' ? ['image.jpg', 'video.mp4'] : ['image.jpg', 'audio.m4a'];

  const batchRes = await fetch(API_ENDPOINTS.GET_BATCH_S3_UPLOAD_URLS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      explorer_id: explorerId,
      event_id: eventID,
      path: 'to',
      files: filesToSign,
    }),
  });

  if (!batchRes.ok) {
    throw new Error(`Failed to get upload URLs: ${batchRes.status}`);
  }

  const batchJson = await parseJsonRecord(batchRes);
  const urls = isRecord(batchJson?.urls) ? batchJson.urls : null;
  if (!urls) {
    throw new Error('Upload service returned no upload URLs');
  }

  const imageUploadUrl = asOptionalString(urls['image.jpg']);
  if (!imageUploadUrl) {
    throw new Error('Upload service returned no image upload URL');
  }

  const posterUri = await resolvePosterUri(reactionType, {
    recordedVideoUri,
    parentPosterUri,
  });
  diagnosticsAppLog('reactionUpload', 'upload:poster-ready', { reactionType });

  const uploadPromises: Promise<void>[] = [safeUploadToS3(posterUri, imageUploadUrl)];

  if (reactionType === 'selfie') {
    const videoUploadUrl = asOptionalString(urls['video.mp4']);
    if (!videoUploadUrl || !recordedVideoUri) {
      throw new Error('Upload service returned incomplete selfie upload URLs');
    }
    uploadPromises.push(
      FileSystem.uploadAsync(videoUploadUrl, recordedVideoUri, {
        httpMethod: 'PUT',
        headers: { 'Content-Type': 'video/mp4' },
      }).then((res) => {
        if (res.status !== 200) {
          throw new Error(`Video upload failed: ${res.status}`);
        }
      }),
    );
  } else {
    const audioUploadUrl = asOptionalString(urls['audio.m4a']);
    if (!audioUploadUrl) {
      throw new Error('Upload service returned no audio upload URL');
    }

    let audioSourceUri: string;
    if (reactionType === 'typed') {
      const { captionVoice } = await loadVoicePreferences();
      audioSourceUri = await generateTypedReactionAudio(
        messageText!.trim(),
        explorerId,
        captionVoice,
        senderName,
      );
    } else {
      audioSourceUri = recordedAudioUri!;
    }

    uploadPromises.push(safeUploadToS3(audioSourceUri, audioUploadUrl));
  }

  await Promise.all(uploadPromises);
  diagnosticsAppLog('reactionUpload', 'upload:s3-done', { reactionType, eventId: eventID });

  const timestamp = new Date().toISOString();
  const trimmedMessage = messageText?.trim() ?? '';
  const eventMetadata: EventMetadata = {
    description: reactionType === 'typed' ? trimmedMessage : '',
    sender: senderName || 'Companion',
    sender_id: senderId,
    timestamp,
    event_id: eventID,
    content_type: reactionType === 'selfie' ? 'video' : 'audio',
    image_source: 'camera',
    ...(reactionType === 'selfie' ? { is_selfie: true } : {}),
    ...(reactionType === 'typed'
      ? { reaction_message: trimmedMessage, description: trimmedMessage }
      : {}),
  };

  const firestorePayload: Record<string, unknown> = {
    explorerId,
    event_id: eventID,
    sender: senderName || 'Companion',
    sender_id: senderId,
    status: 'ready',
    timestamp: serverTimestamp(),
    type: 'mirror_event',
    metadata: eventMetadata,
    engagement_count: 0,
    likedBy: [],
    respondedRelationshipIds: [],
    isReaction: true,
    parentReflectionId,
    reactionType,
    syncStartTimeMillis,
    responderRelationshipId: activeRelationshipId,
    ...(isNarration ? { isNarration: true } : {}),
  };

  const eventDocRef = doc(collection(db, ExplorerConfig.collections.reflections), eventID);
  await setDoc(eventDocRef, firestorePayload, { merge: true });

  // Narration is the author's own layer on their Reflection, not a response —
  // leave the parent's respondedRelationshipIds untouched.
  if (!isNarration) {
    const parentRef = doc(db, ExplorerConfig.collections.reflections, parentReflectionId);
    await updateDoc(parentRef, {
      respondedRelationshipIds: arrayUnion(activeRelationshipId),
    });
  }

  diagnosticsAppLog('reactionUpload', 'upload:firestore-done', {
    reactionType,
    eventId: eventID,
    ...(isNarration ? { isNarration: true } : {}),
  });

  return eventID;
}

/** @deprecated Use uploadReaction instead */
export async function uploadReactionSelfie(
  params: Omit<UploadReactionParams, 'reactionType'> & { recordedUri: string },
): Promise<string> {
  return uploadReaction({
    ...params,
    reactionType: 'selfie',
    recordedVideoUri: params.recordedUri,
  });
}
