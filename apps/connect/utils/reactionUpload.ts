import { ensureFileUri, prepareImageForUpload } from '@/utils/mediaProcessor';
import { API_ENDPOINTS, EventMetadata, ExplorerConfig } from '@projectmirror/shared';
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

export type UploadReactionSelfieParams = {
  explorerId: string;
  parentReflectionId: string;
  recordedUri: string;
  syncStartTimeMillis: number;
  senderName: string;
  senderId: string;
  activeRelationshipId: string;
};

export async function uploadReactionSelfie({
  explorerId,
  parentReflectionId,
  recordedUri,
  syncStartTimeMillis,
  senderName,
  senderId,
  activeRelationshipId,
}: UploadReactionSelfieParams): Promise<string> {
  const eventID = Date.now().toString();
  const filesToSign = ['image.jpg', 'video.mp4'];

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
  const videoUploadUrl = asOptionalString(urls['video.mp4']);
  if (!imageUploadUrl || !videoUploadUrl) {
    throw new Error('Upload service returned incomplete upload URLs');
  }

  const posterUri = await extractReactionPosterUri(recordedUri);
  await Promise.all([
    safeUploadToS3(posterUri, imageUploadUrl),
    FileSystem.uploadAsync(videoUploadUrl, recordedUri, {
      httpMethod: 'PUT',
      headers: { 'Content-Type': 'video/mp4' },
    }).then((res) => {
      if (res.status !== 200) {
        throw new Error(`Video upload failed: ${res.status}`);
      }
    }),
  ]);

  const timestamp = new Date().toISOString();
  const eventMetadata: EventMetadata = {
    description: 'Reaction',
    short_caption: 'Reaction',
    sender: senderName || 'Companion',
    sender_id: senderId,
    timestamp,
    event_id: eventID,
    content_type: 'video',
    image_source: 'camera',
    is_selfie: true,
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
    reactionType: 'selfie',
    syncStartTimeMillis,
    responderRelationshipId: activeRelationshipId,
  };

  const eventDocRef = doc(collection(db, ExplorerConfig.collections.reflections), eventID);
  await setDoc(eventDocRef, firestorePayload, { merge: true });

  const parentRef = doc(db, ExplorerConfig.collections.reflections, parentReflectionId);
  await updateDoc(parentRef, {
    respondedRelationshipIds: arrayUnion(activeRelationshipId),
  });

  return eventID;
}
