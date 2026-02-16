import React, { createContext, useCallback, useContext, useState } from 'react';

export type PendingMedia = {
  uri: string;
  type: 'photo' | 'video';
  source: 'camera' | 'gallery' | 'search';
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
