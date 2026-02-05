import { db } from '@projectmirror/shared/firebase';
import {
    collection,
    DocumentData,
    onSnapshot,
    query,
    QuerySnapshot,
    where
} from 'firebase/firestore';
import { useEffect, useState } from 'react';

export interface Relationship {
  id: string;            // The document ID (auto-generated)
  explorerId: string;    // ✅ UPDATED: Matches your preference (all caps)
  userId: string;
  role: string;
  companionName: string; // "Me" (How you appear to them)
}

export function useRelationships(userId: string | undefined) {
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) {
      setRelationships([]);
      setLoading(false);
      return;
    }

    // Query: "Find all records where I am the user"
    const q = query(
      collection(db, 'relationships'),
      where('userId', '==', userId)
    );

    const unsubscribe = onSnapshot(q, (snapshot: QuerySnapshot<DocumentData>) => {
      const results: Relationship[] = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        results.push({
          id: doc.id,
          explorerId: data.explorerId, // ✅ Matches DB field
          userId: data.userId,
          role: data.role,
          companionName: data.companionName,
        } as Relationship);
      });
      
      setRelationships(results);
      setLoading(false);
    }, (error) => {
      console.error("Error fetching relationships:", error);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [userId]);

  return { relationships, loading };
}