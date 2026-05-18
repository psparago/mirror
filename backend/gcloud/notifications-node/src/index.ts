import {cloudEvent} from '@google-cloud/functions-framework';
import {getApps, initializeApp} from 'firebase-admin/app';
import {FieldValue, Timestamp, getFirestore} from 'firebase-admin/firestore';
import type {DocumentData, QueryDocumentSnapshot} from 'firebase-admin/firestore';
import {getMessaging} from 'firebase-admin/messaging';

const PENDING_NOTIFICATIONS_COLLECTION = 'pending_notifications';
const RELATIONSHIPS_COLLECTION = 'relationships';
const SYSTEM_CONFIG_COLLECTION = 'system_config';
const USERS_COLLECTION = 'users';
const PENDING_STATUS = 'pending';
const COMPANION_UPLOAD_TRIGGER = 'companion_upload';
const EXPLORER_LIKE_TRIGGER = 'explorer_like';
const DEFAULT_DEBOUNCE_MINUTES = 15;
const DEFAULT_MIN_HOURS_BETWEEN_DIGESTS = 4;
const LAST_UPLOAD_DIGEST_AT_FIELD = 'lastUploadDigestSentAt';

type FirestoreValue = {
  stringValue?: string;
  booleanValue?: boolean;
  arrayValue?: {
    values?: FirestoreValue[];
  };
  mapValue?: {
    fields?: Record<string, FirestoreValue>;
  };
};

type FirestoreDocument = {
  name?: string;
  fields?: Record<string, FirestoreValue>;
};

type FirestoreCreateEventData = {
  value?: FirestoreDocument;
};

type FastLaneCloudEvent<T> = {
  data?: T;
};

type PendingNotification = {
  explorerId: string;
  recipientIds: string[];
  triggerType: string;
  reflectionId: string;
  senderName: string;
  status: string;
};

type SlowLaneNotification = {
  doc: QueryDocumentSnapshot<DocumentData>;
  explorerId: string;
  senderName: string;
  createdAtMillis: number;
  processedRecipients: Record<string, ProcessedRecipient>;
};

type SlowLaneConfig = {
  debounceMinutes: number;
  minHoursBetweenDigests: number;
};

type ActiveCompanion = {
  userId: string;
  relationshipCreatedAtMillis: number | null;
};

type ProcessedRecipientStatus =
  | 'sent'
  | 'skipped_joined_late'
  | 'skipped_cooldown'
  | 'skipped_push_disabled'
  | 'missing_token';

type ProcessedRecipient = {
  status: ProcessedRecipientStatus;
  processedAt: FieldValue;
  messageId?: string;
};

if (getApps().length === 0) {
  initializeApp();
}

const db = getFirestore();
const messaging = getMessaging();

function stringField(fields: Record<string, FirestoreValue>, key: string): string {
  return fields[key]?.stringValue?.trim() ?? '';
}

function stringArrayField(fields: Record<string, FirestoreValue>, key: string): string[] {
  return (
    fields[key]?.arrayValue?.values
      ?.map((value) => value.stringValue?.trim() ?? '')
      .filter((value) => value.length > 0) ?? []
  );
}

function documentPathFromName(name: string): string {
  const documentsPrefix = '/documents/';
  const documentsIndex = name.indexOf(documentsPrefix);

  if (documentsIndex === -1) {
    return '';
  }

  return name.slice(documentsIndex + documentsPrefix.length);
}

function pendingNotificationFromDocument(document: FirestoreDocument): PendingNotification {
  const fields = document.fields ?? {};

  return {
    explorerId: stringField(fields, 'explorerId'),
    recipientIds: stringArrayField(fields, 'recipientIds'),
    triggerType: stringField(fields, 'triggerType'),
    reflectionId: stringField(fields, 'reflectionId'),
    senderName: stringField(fields, 'senderName') || 'Someone',
    status: stringField(fields, 'status'),
  };
}

function timestampMillis(value: unknown): number | null {
  if (value instanceof Timestamp) {
    return value.toMillis();
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const millis = Date.parse(value);
    return Number.isFinite(millis) ? millis : null;
  }
  if (value && typeof value === 'object' && 'toMillis' in value) {
    const maybeTimestamp = value as {toMillis?: () => number};
    const millis = maybeTimestamp.toMillis?.();
    return typeof millis === 'number' && Number.isFinite(millis) ? millis : null;
  }
  return null;
}

function processedRecipientMap(value: unknown): Record<string, ProcessedRecipient> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, ProcessedRecipient>;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function uniqueSenderNames(notifications: SlowLaneNotification[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];

  for (const notification of notifications) {
    if (seen.has(notification.senderName)) {
      continue;
    }
    seen.add(notification.senderName);
    names.push(notification.senderName);
  }

  return names;
}

function slowLaneBody(senderNames: string[]): string {
  if (senderNames.length === 1) {
    return `${senderNames[0]} posted a new Reflection.`;
  }
  if (senderNames.length === 2) {
    return `${senderNames[0]} and ${senderNames[1]} posted new Reflections.`;
  }
  return `${senderNames[0]}, ${senderNames[1]}, and ${senderNames.length - 2} others posted new Reflections.`;
}

async function slowLaneConfig(explorerId: string): Promise<SlowLaneConfig> {
  const snapshot = await db.collection(SYSTEM_CONFIG_COLLECTION).doc(explorerId).get();
  const data = snapshot.data() ?? {};

  return {
    debounceMinutes: positiveNumber(data.debounce_minutes, DEFAULT_DEBOUNCE_MINUTES),
    minHoursBetweenDigests: positiveNumber(
      data.min_hours_between_digests,
      DEFAULT_MIN_HOURS_BETWEEN_DIGESTS
    ),
  };
}

function activeCompanionsFromSnapshot(
  docs: QueryDocumentSnapshot<DocumentData>[]
): ActiveCompanion[] {
  const seen = new Set<string>();
  const companions: ActiveCompanion[] = [];

  for (const doc of docs) {
    const data = doc.data();
    const userId = typeof data.userId === 'string' ? data.userId.trim() : '';
    if (!userId || seen.has(userId)) {
      continue;
    }

    seen.add(userId);
    companions.push({
      userId,
      relationshipCreatedAtMillis:
        timestampMillis(data.createdAt) ?? timestampMillis(data.joined_at),
    });
  }

  return companions;
}

function recipientState(
  status: ProcessedRecipientStatus,
  messageId?: string
): ProcessedRecipient {
  return {
    status,
    processedAt: FieldValue.serverTimestamp(),
    ...(messageId ? {messageId} : {}),
  };
}

async function commitSlowLaneUpdates(
  notifications: SlowLaneNotification[],
  activeCompanionIds: string[],
  recipientUpdates: Map<string, Record<string, ProcessedRecipient>>
): Promise<void> {
  const batch = db.batch();
  let writeCount = 0;

  for (const notification of notifications) {
    const updates = recipientUpdates.get(notification.doc.id) ?? {};
    const isComplete = activeCompanionIds.every(
      (companionId) => notification.processedRecipients[companionId]
    );

    if (Object.keys(updates).length === 0 && !isComplete) {
      continue;
    }

    batch.set(
      notification.doc.ref,
      {
        ...(Object.keys(updates).length > 0 ? {processedRecipients: updates} : {}),
        ...(isComplete
          ? {
              status: 'sent',
              processedAt: FieldValue.serverTimestamp(),
            }
          : {}),
      },
      {merge: true}
    );
    writeCount++;
  }

  if (writeCount > 0) {
    await batch.commit();
  }
}

export async function sendFastLaneNotification(
  event: FastLaneCloudEvent<FirestoreCreateEventData>
): Promise<void> {
  const document = event.data?.value;

  if (!document?.name) {
    console.warn('sendFastLaneNotification: created event missing document name');
    return;
  }

  const notificationPath = documentPathFromName(document.name);
  if (!notificationPath.startsWith(`${PENDING_NOTIFICATIONS_COLLECTION}/`)) {
    console.warn(`sendFastLaneNotification: unexpected document path ${notificationPath}`);
    return;
  }

  const notificationRef = db.doc(notificationPath);
  const notification = pendingNotificationFromDocument(document);

  if (notification.status !== PENDING_STATUS || notification.triggerType !== EXPLORER_LIKE_TRIGGER) {
    return;
  }

  const [recipientId] = notification.recipientIds;
  if (!recipientId) {
    await notificationRef.update({status: 'missing_token'});
    return;
  }

  const userSnapshot = await db.collection(USERS_COLLECTION).doc(recipientId).get();
  const userData = userSnapshot.data() ?? {};

  if (userData.push_notifications_enabled === false) {
    await notificationRef.update({status: 'skipped'});
    return;
  }

  const pushToken = typeof userData.pushToken === 'string' ? userData.pushToken.trim() : '';
  if (!pushToken) {
    await notificationRef.update({status: 'missing_token'});
    return;
  }

  const body = `❤️ ${notification.senderName} loved your Reflection!`;
  const messageId = await messaging.send({
    token: pushToken,
    notification: {
      body,
    },
    data: {
      reflectionId: notification.reflectionId,
    },
    android: {
      priority: 'high',
      notification: {
        body,
      },
    },
    apns: {
      headers: {
        'apns-priority': '10',
      },
      payload: {
        aps: {
          alert: {
            body,
          },
          sound: 'default',
        },
      },
    },
  });

  await notificationRef.update({
    status: 'sent',
    processedAt: FieldValue.serverTimestamp(),
  });

  console.log(`sendFastLaneNotification: sent ${notificationPath} as ${messageId}`);
}

export async function aggregateSlowLaneNotifications(): Promise<void> {
  const pendingSnapshot = await db
    .collection(PENDING_NOTIFICATIONS_COLLECTION)
    .where('status', '==', PENDING_STATUS)
    .where('triggerType', '==', COMPANION_UPLOAD_TRIGGER)
    .get();

  if (pendingSnapshot.empty) {
    console.log('aggregateSlowLaneNotifications: no pending companion uploads');
    return;
  }

  const now = Date.now();
  const byExplorer = new Map<string, SlowLaneNotification[]>();

  for (const doc of pendingSnapshot.docs) {
    const data = doc.data();
    const explorerId = typeof data.explorerId === 'string' ? data.explorerId.trim() : '';
    if (!explorerId) {
      console.warn(`aggregateSlowLaneNotifications: skipping ${doc.ref.path}; missing explorerId`);
      continue;
    }

    const notification: SlowLaneNotification = {
      doc,
      explorerId,
      senderName:
        typeof data.senderName === 'string' && data.senderName.trim()
          ? data.senderName.trim()
          : 'Someone',
      createdAtMillis: timestampMillis(data.createdAt) ?? 0,
      processedRecipients: processedRecipientMap(data.processedRecipients),
    };
    const group = byExplorer.get(explorerId) ?? [];
    group.push(notification);
    byExplorer.set(explorerId, group);
  }

  for (const [explorerId, notifications] of byExplorer) {
    const config = await slowLaneConfig(explorerId);
    const oldestCreatedAt = Math.min(...notifications.map((notification) => notification.createdAtMillis));
    const debounceMillis = config.debounceMinutes * 60 * 1000;

    if (now - oldestCreatedAt < debounceMillis) {
      console.log(
        `aggregateSlowLaneNotifications: waiting for debounce window on explorer ${explorerId}`
      );
      continue;
    }

    const relationshipsSnapshot = await db
      .collection(RELATIONSHIPS_COLLECTION)
      .where('explorerId', '==', explorerId)
      .where('role', '==', 'companion')
      .get();

    const activeCompanions = activeCompanionsFromSnapshot(relationshipsSnapshot.docs);
    const activeCompanionIds = activeCompanions.map((companion) => companion.userId);
    const recipientUpdates = new Map<string, Record<string, ProcessedRecipient>>();

    if (activeCompanionIds.length === 0) {
      console.log(`aggregateSlowLaneNotifications: no active companions for ${explorerId}`);
      await commitSlowLaneUpdates(notifications, activeCompanionIds, recipientUpdates);
      continue;
    }

    const cooldownMillis = config.minHoursBetweenDigests * 60 * 60 * 1000;

    const markProcessed = (
      notification: SlowLaneNotification,
      companionId: string,
      state: ProcessedRecipient
    ) => {
      notification.processedRecipients[companionId] = state;
      const updates = recipientUpdates.get(notification.doc.id) ?? {};
      updates[companionId] = state;
      recipientUpdates.set(notification.doc.id, updates);
    };

    for (const companion of activeCompanions) {
      const companionId = companion.userId;
      const eligibleNotifications: SlowLaneNotification[] = [];

      for (const notification of notifications) {
        if (notification.processedRecipients[companionId]) {
          continue;
        }

        if (
          companion.relationshipCreatedAtMillis !== null &&
          notification.createdAtMillis < companion.relationshipCreatedAtMillis
        ) {
          markProcessed(notification, companionId, recipientState('skipped_joined_late'));
          continue;
        }

        eligibleNotifications.push(notification);
      }

      if (eligibleNotifications.length === 0) {
        continue;
      }

      const userRef = db.collection(USERS_COLLECTION).doc(companionId);
      const userSnapshot = await userRef.get();
      const userData = userSnapshot.data() ?? {};

      if (userData.push_notifications_enabled === false) {
        for (const notification of eligibleNotifications) {
          markProcessed(notification, companionId, recipientState('skipped_push_disabled'));
        }
        continue;
      }

      const lastDigestAt = timestampMillis(userData[LAST_UPLOAD_DIGEST_AT_FIELD]);
      if (lastDigestAt !== null && now - lastDigestAt < cooldownMillis) {
        for (const notification of eligibleNotifications) {
          markProcessed(notification, companionId, recipientState('skipped_cooldown'));
        }
        continue;
      }

      const pushToken = typeof userData.pushToken === 'string' ? userData.pushToken.trim() : '';
      if (!pushToken) {
        for (const notification of eligibleNotifications) {
          markProcessed(notification, companionId, recipientState('missing_token'));
        }
        continue;
      }

      try {
        const body = slowLaneBody(uniqueSenderNames(eligibleNotifications));
        const messageId = await messaging.send({
          token: pushToken,
          notification: {
            body,
          },
          data: {
            notificationType: 'companion_upload_digest',
            explorerId,
          },
          android: {
            priority: 'high',
            notification: {
              body,
            },
          },
          apns: {
            headers: {
              'apns-priority': '10',
            },
            payload: {
              aps: {
                alert: {
                  body,
                },
                sound: 'default',
              },
            },
          },
        });

        await userRef.update({
          [LAST_UPLOAD_DIGEST_AT_FIELD]: FieldValue.serverTimestamp(),
        });
        for (const notification of eligibleNotifications) {
          markProcessed(notification, companionId, recipientState('sent', messageId));
        }
        console.log(
          `aggregateSlowLaneNotifications: sent digest for explorer ${explorerId} to ${companionId} as ${messageId}`
        );
      } catch (error) {
        console.error(
          `aggregateSlowLaneNotifications: failed sending digest for explorer ${explorerId} to ${companionId}`,
          error
        );
      }
    }

    await commitSlowLaneUpdates(notifications, activeCompanionIds, recipientUpdates);
  }
}

cloudEvent('sendFastLaneNotification', async (event: unknown) => {
  await sendFastLaneNotification(event as FastLaneCloudEvent<FirestoreCreateEventData>);
});

cloudEvent('aggregateSlowLaneNotifications', async () => {
  await aggregateSlowLaneNotifications();
});
