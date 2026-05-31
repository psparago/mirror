import ReflectionsAudio, { type AudioOutputRoute } from '@/modules/reflections-audio';
import { useEffect, useState } from 'react';

const EMPTY_ROUTE: AudioOutputRoute = { hasHeadphones: false, outputs: [] };

/** Synchronously reads the current audio output route, falling back safely if the native module
 *  is unavailable (web bundling, Expo Go, or an out-of-date dev client). */
export function getAudioRoute(): AudioOutputRoute {
  try {
    return ReflectionsAudio?.getAudioRoute() ?? EMPTY_ROUTE;
  } catch {
    return EMPTY_ROUTE;
  }
}

/**
 * Subscribes to the device's audio output route while `active`. Used by the reaction recorder to
 * decide whether the parent Reflection audio can play out loud (headphones connected → no echo).
 */
export function useAudioRoute(active: boolean): AudioOutputRoute {
  const [route, setRoute] = useState<AudioOutputRoute>(EMPTY_ROUTE);

  useEffect(() => {
    if (!active || !ReflectionsAudio) return;

    setRoute(getAudioRoute());

    let subscription: { remove: () => void } | undefined;
    try {
      subscription = ReflectionsAudio.addListener('onAudioRouteChange', (next) => {
        setRoute(next ?? EMPTY_ROUTE);
      });
    } catch {
      subscription = undefined;
    }

    return () => subscription?.remove();
  }, [active]);

  return route;
}
