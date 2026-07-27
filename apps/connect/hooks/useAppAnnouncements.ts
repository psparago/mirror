import AsyncStorage from '@react-native-async-storage/async-storage';
import { db, doc, onSnapshot } from '@projectmirror/shared/firebase';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TipContent } from '@/utils/tips';
import { shouldShowAnnouncement } from '@/utils/announcementGate';

/**
 * Firestore docs under `app_config/`:
 *
 * - `connect_system_message` — ops / broadcast (shown first when both pending)
 * - `connect_whats_new` — product news
 *
 * Schema:
 * {
 *   enabled: boolean,       // false or missing → never show (park copy safely)
 *   version: string|number, // bump when publishing new copy
 *   title?: string,
 *   body: string
 * }
 *
 * Clients store last dismissed version per channel in AsyncStorage.
 * Show when: enabled===true && version && body && version !== seen.
 */

export const APP_CONFIG_COLLECTION = 'app_config';
export const SYSTEM_MESSAGE_DOC_ID = 'connect_system_message';
export const WHATS_NEW_DOC_ID = 'connect_whats_new';

export const SYSTEM_MESSAGE_SEEN_KEY = '@reflections/connect_system_message_seen_v1';
export const WHATS_NEW_SEEN_KEY = '@reflections/connect_whats_new_seen_v1';

export type AnnouncementChannel = 'system' | 'whats_new';

export type AnnouncementPayload = TipContent & {
  channel: AnnouncementChannel;
  version: string;
};

async function getSeenVersion(storageKey: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

async function markSeenVersion(storageKey: string, version: string): Promise<void> {
  if (!version) return;
  await AsyncStorage.setItem(storageKey, version);
}

export async function clearWhatsNewSeen(): Promise<void> {
  await AsyncStorage.removeItem(WHATS_NEW_SEEN_KEY);
}

export async function clearSystemMessageSeen(): Promise<void> {
  await AsyncStorage.removeItem(SYSTEM_MESSAGE_SEEN_KEY);
}

/** Clears both announcement “already seen” flags (Settings → Reset tips). */
export async function clearAllAnnouncementSeen(): Promise<void> {
  await Promise.all([clearWhatsNewSeen(), clearSystemMessageSeen()]);
}

type ChannelConfig = {
  channel: AnnouncementChannel;
  docId: string;
  storageKey: string;
  defaultTitle: string;
};

const CHANNELS: ChannelConfig[] = [
  {
    channel: 'system',
    docId: SYSTEM_MESSAGE_DOC_ID,
    storageKey: SYSTEM_MESSAGE_SEEN_KEY,
    defaultTitle: 'Heads up',
  },
  {
    channel: 'whats_new',
    docId: WHATS_NEW_DOC_ID,
    storageKey: WHATS_NEW_SEEN_KEY,
    defaultTitle: "What's new",
  },
];

/**
 * Subscribes to one `app_config` announcement doc.
 * `pending` is true when remote qualifies and is unseen (whether or not this hook is displaying).
 */
function useAppAnnouncementChannel(
  subscribe: boolean,
  config: ChannelConfig,
): {
  pending: AnnouncementPayload | null;
  dismiss: () => void;
} {
  const [pending, setPending] = useState<AnnouncementPayload | null>(null);
  const pendingVersionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!subscribe) {
      setPending(null);
      pendingVersionRef.current = null;
      return;
    }

    const unsub = onSnapshot(
      doc(db, APP_CONFIG_COLLECTION, config.docId),
      async (snap) => {
        if (!snap.exists()) {
          setPending(null);
          pendingVersionRef.current = null;
          return;
        }
        const data = snap.data() as Record<string, unknown>;
        const seen = await getSeenVersion(config.storageKey);
        const decision = shouldShowAnnouncement(data, seen, config.defaultTitle);
        if (!decision.show) {
          setPending(null);
          pendingVersionRef.current = null;
          return;
        }

        pendingVersionRef.current = decision.version;
        setPending({
          channel: config.channel,
          version: decision.version,
          title: decision.title,
          body: decision.body,
        });
      },
      (err) => {
        console.warn(`[Announcement:${config.channel}] snapshot failed`, err);
      },
    );

    return () => unsub();
  }, [subscribe, config.channel, config.docId, config.storageKey, config.defaultTitle]);

  const dismiss = useCallback(() => {
    const version = pendingVersionRef.current;
    setPending(null);
    pendingVersionRef.current = null;
    if (version) {
      void markSeenVersion(config.storageKey, version);
    }
  }, [config.storageKey]);

  return { pending, dismiss };
}

/**
 * System message first, then What’s New. Single TipModal surface.
 */
export function useConnectAnnouncements(subscribe: boolean) {
  const system = useAppAnnouncementChannel(subscribe, CHANNELS[0]);
  const whatsNew = useAppAnnouncementChannel(subscribe, CHANNELS[1]);

  const active: AnnouncementPayload | null = useMemo(() => {
    if (system.pending) return system.pending;
    if (whatsNew.pending) return whatsNew.pending;
    return null;
  }, [system.pending, whatsNew.pending]);

  const dismiss = useCallback(() => {
    if (system.pending) {
      system.dismiss();
      return;
    }
    if (whatsNew.pending) {
      whatsNew.dismiss();
    }
  }, [system.pending, system.dismiss, whatsNew.pending, whatsNew.dismiss]);

  return {
    visible: !!active,
    content: active,
    channel: active?.channel ?? null,
    dismiss,
  };
}
