import { arrayRemove, arrayUnion, db, doc, updateDoc } from '../firebase';
import { ExplorerConfig } from '../explorer/ExplorerConfig';

const LIKE_DEBOUNCE_MS = 2000;

type PendingLike = {
  timer: ReturnType<typeof setTimeout>;
  reflectionId: string;
  userId: string;
  isAdd: boolean;
};

const pendingLikes = new Map<string, PendingLike>();

function likeKey(reflectionId: string, userId: string): string {
  return `${reflectionId}:${userId}`;
}

/**
 * Debounced Reflections like toggle. Rapid taps are collapsed so Firestore only
 * receives the final state for this Reflection/user pair.
 */
export function toggleReflectionLike(reflectionId: string, userId: string, isAdd: boolean): void {
  const trimmedReflectionId = reflectionId.trim();
  const trimmedUserId = userId.trim();
  if (!trimmedReflectionId || !trimmedUserId) return;

  const key = likeKey(trimmedReflectionId, trimmedUserId);
  const pending = pendingLikes.get(key);
  if (pending) {
    clearTimeout(pending.timer);
    if (pending.isAdd !== isAdd) {
      pendingLikes.delete(key);
      return;
    }
  }

  const timer = setTimeout(() => {
    pendingLikes.delete(key);
    const reflectionRef = doc(db, ExplorerConfig.collections.reflections, trimmedReflectionId);
    updateDoc(reflectionRef, {
      likedBy: isAdd ? arrayUnion(trimmedUserId) : arrayRemove(trimmedUserId),
    }).catch((error) => {
      console.error('Reflections like update failed:', error);
    });
  }, LIKE_DEBOUNCE_MS);

  pendingLikes.set(key, {
    timer,
    reflectionId: trimmedReflectionId,
    userId: trimmedUserId,
    isAdd,
  });
}
