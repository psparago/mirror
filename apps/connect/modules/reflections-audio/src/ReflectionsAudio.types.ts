/**
 * Describes the device's current audio output route.
 *
 * `hasHeadphones` is the signal the reaction recorder uses to decide whether the
 * parent Reflection audio can play out loud during recording: when headphones or
 * Bluetooth are connected there is no acoustic echo path, so the audio is safe to play.
 */
export type AudioOutputRoute = {
  /** True when audio is routed to headphones / Bluetooth / USB / hearing aids (no speaker echo path). */
  hasHeadphones: boolean;
  /** Raw platform output port identifiers, primarily for debugging/telemetry. */
  outputs: string[];
};

export type ReflectionsAudioModuleEvents = {
  /** Fired whenever the active audio output route changes (e.g. headphones plugged/unplugged). */
  onAudioRouteChange: (route: AudioOutputRoute) => void;
};
