import {cloudEvent} from '@google-cloud/functions-framework';
import {getApps, initializeApp} from 'firebase-admin/app';
import {FieldValue, getFirestore} from 'firebase-admin/firestore';
import {getMessaging} from 'firebase-admin/messaging';

const PENDING_NOTIFICATIONS_COLLECTION = 'pending_notifications';
const USERS_COLLECTION = 'users';
const PENDING_STATUS = 'pending';
const EXPLORER_LIKE_TRIGGER = 'explorer_like';

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
  recipientIds: string[];
  triggerType: string;
  reflectionId: string;
  senderName: string;
  status: string;
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
    recipientIds: stringArrayField(fields, 'recipientIds'),
    triggerType: stringField(fields, 'triggerType'),
    reflectionId: stringField(fields, 'reflectionId'),
    senderName: stringField(fields, 'senderName') || 'Someone',
    status: stringField(fields, 'status'),
  };
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

cloudEvent('sendFastLaneNotification', async (event: unknown) => {
  await sendFastLaneNotification(event as FastLaneCloudEvent<FirestoreCreateEventData>);
});
