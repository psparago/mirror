import React, { createContext, useCallback, useContext, useState } from 'react';

export type PendingMedia = {
  uri: string;
  type: 'photo' | 'video';
  source: 'camera' | 'gallery' | 'search';
  /** Source screens can return an explicit cancellation so CreationModal does not wait for timeout recovery. */
  cancelled?: boolean;
  cancelTitle?: string;
  cancelDetail?: string;
  /** When true, reflection metadata marks this as a companion selfie for the Explorer. */
  isSelfie?: boolean;
  searchQuery?: string;
  searchCanonicalName?: string;
  /** Library asset id (e.g. Unsplash `id`). */
  libraryId?: string;
  /** Search query used to find the asset (e.g. current Unsplash search bar). */
  librarySearchTerm?: string;
};

type ReflectionMediaContextType = {
  pendingMedia: PendingMedia | null;
  setPendingMedia: (media: PendingMedia | null) => void;
  consumePendingMedia: () => PendingMedia | null;
};

const ReflectionMediaContext = createContext<ReflectionMediaContextType>({
  pendingMedia: null,
  setPendingMedia: () => {},
  consumePendingMedia: () => null,
});

export function ReflectionMediaProvider({ children }: { children: React.ReactNode }) {
  const [pendingMedia, setPendingMedia] = useState<PendingMedia | null>(null);

  const consumePendingMedia = useCallback(() => {
    const media = pendingMedia;
    setPendingMedia(null);
    return media;
  }, [pendingMedia]);

  return (
    <ReflectionMediaContext.Provider value={{ pendingMedia, setPendingMedia, consumePendingMedia }}>
      {children}
    </ReflectionMediaContext.Provider>
  );
}

export function useReflectionMedia() {
  return useContext(ReflectionMediaContext);
}
