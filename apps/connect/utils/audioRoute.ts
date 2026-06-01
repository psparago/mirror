import { useState } from 'react';

export type AudioOutputRoute = {
  hasHeadphones: boolean;
  outputs: string[];
};

const EMPTY_ROUTE: AudioOutputRoute = { hasHeadphones: false, outputs: [] };

/** Returns the current audio output route (speaker assumed when detection is unavailable). */
export function getAudioRoute(): AudioOutputRoute {
  return EMPTY_ROUTE;
}

/**
 * Subscribes to the device's audio output route while `active`.
 * Without a native route module, defaults to speaker — Original audio stays off until toggled.
 */
export function useAudioRoute(_active: boolean): AudioOutputRoute {
  const [route] = useState<AudioOutputRoute>(EMPTY_ROUTE);
  return route;
}
