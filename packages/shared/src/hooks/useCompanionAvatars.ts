import {
  collection,
  DocumentData,
  onSnapshot,
  query,
  QuerySnapshot,
  where,
} from 'firebase/firestore';
import { useEffect, useRef, useState } from 'react';
import { API_ENDPOINTS } from '../api/endpoints';
import { db } from '../firebase';
import { getAvatarColor, getAvatarInitial } from '../utils/avatarDefaults';

export interface CompanionAvatar {
  userId: string;
  companionName: string;
  avatarUrl: string | null;
  avatarS3Key: string | null;
  color: string;
  initial: string;
}

export function useCompanionAvatars(explorerId: string | null): {
  companions: CompanionAvatar[];
  loading: boolean;
} {
  const [companions, setCompanions] = useState<CompanionAvatar[]>([]);
  const [loading, setLoading] = useState(true);
  const resolveGenRef = useRef(0);

  useEffect(() => {
    if (!explorerId) {
      console.log('[useCompanionAvatars] no explorerId, skipping');
      setCompanions([]);
      setLoading(false);
      return;
    }

    const q = query(
      collection(db, 'relationships'),
      where('explorerId', '==', explorerId)
    );

    const unsubscribe = onSnapshot(q, async (snapshot: QuerySnapshot<DocumentData>) => {
      const gen = ++resolveGenRef.current;
      console.log(`[useCompanionAvatars] snapshot for ${explorerId}: ${snapshot.docs.length} relationships`);

      const rawCompanions = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          userId: data.userId as string,
          companionName: (data.companionName as string) || 'Companion',
          avatarS3Key: (data.companionAvatarS3Key as string) || null,
        };
      });

      const resolved: CompanionAvatar[] = await Promise.all(
        rawCompanions.map(async (c) => {
          let avatarUrl: string | null = null;
          if (c.avatarS3Key) {
            try {
              const res = await fetch(
                `${API_ENDPOINTS.GET_S3_URL}?explorer_id=${explorerId}&event_id=${c.userId}&filename=avatar.jpg&path=avatars&method=GET`
              );
              if (res.ok) {
                const { url } = await res.json();
                avatarUrl = url;
              }
            } catch { /* use fallback */ }
          }
          return {
            userId: c.userId,
            companionName: c.companionName,
            avatarUrl,
            avatarS3Key: c.avatarS3Key,
            color: getAvatarColor(c.userId),
            initial: getAvatarInitial(c.companionName),
          };
        })
      );

      if (gen !== resolveGenRef.current) return;
      setCompanions(resolved);
      setLoading(false);
    }, (error) => {
      console.error('Error fetching companion avatars:', error);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [explorerId]);

  return { companions, loading };
}
