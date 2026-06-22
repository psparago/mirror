import {
  defaultReactionOriginalAudioEnabled,
  formatTypedReactionSpeechText,
  resolveReactionRecordingVolume,
  type SelfieRecordingAudioSnapshot,
} from '@/utils/reactionPlayback';
import { uploadReaction, generateTypedReactionAudio } from '@/utils/reactionUpload';
import { ensureFileUri } from '@/utils/mediaProcessor';
import { loadVoicePreferences } from '@/utils/ttsVoices';
import { useAudioRoute } from '@/utils/audioRoute';
import {
  configureConnectPlaybackAudioSessionAsync,
  configureConnectReactionRecordingAudioSessionAsync,
  configureConnectVoiceReactionRecordingAsync,
  releaseConnectCaptureAudioAsync,
  runConnectAvCommandWithRetry,
  waitForStableAndroidAppForeground,
} from '@/utils/audioSession';
import { diagnosticsAppLog, type DiagnosticLogLevel } from '@/utils/diagnosticsLog';
import { FontAwesome } from '@expo/vector-icons';
import {
  useAuth,
  useExplorer,
  VideoTrimSlider,
  useCompanionAvatars,
  API_ENDPOINTS,
  getAvatarColor,
  getAvatarInitial,
  type ReactionType,
} from '@projectmirror/shared';
import { Audio, ResizeMode, Video, type AVPlaybackStatus } from 'expo-av';
import { Camera, CameraView, useCameraPermissions } from 'expo-camera';
import { useVideoPlayer, type VideoPlayer, type VideoSource } from 'expo-video';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  useAudioRecorder,
} from 'expo-audio';
import { Image } from 'expo-image';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CompanionPreviewOverlay } from './reaction/CompanionPreviewOverlay';
import { reactionPipStyles } from './reaction/reactionPipStyles';
import { SelfieComposePane } from './reaction/SelfieComposePane';
import { TypedComposePane } from './reaction/TypedComposePane';
import { VoiceComposePane } from './reaction/VoiceComposePane';

const PREVIEW_END_EPSILON_MS = 80;
const MIN_TRIM_GAP_MS = 500;
const RECORDING_PARENT_REASSERT_DELAYS_MS = [250, 600];
const SELFIE_CAMERA_BIND_MS = 400;
const SELFIE_CAMERA_READY_TIMEOUT_MS = 8000;
/**
 * expo-camera's onCameraReady is unreliable on this iOS old-arch build — it
 * sometimes never fires for a perfectly functional, mounted+active session.
 * Once the persistent CameraView has been active this long without reporting
 * ready, we treat it as ready so recording is never permanently blocked.
 */
const SELFIE_CAMERA_READY_FALLBACK_MS = Platform.OS === 'ios' ? 1500 : 800;
/** iOS SDK 52: yield after onCameraReady so native mode=video movie output is wired before recordAsync. */
const SELFIE_VIDEO_MODE_SETTLE_MS = 250;
/** Native recordAsync finalize after stopRecording — not counted against hold duration. */
const SELFIE_RECORD_SAVE_TIMEOUT_MS = 45000;
/** Give expo-video a beat to unload the selfie preview asset before remounting CameraView. */
const SELFIE_RETAKE_PLAYER_RELEASE_MS = Platform.OS === 'ios' ? 650 : 200;
/** Keep the Reflection present but clearly below the selfie reaction audio in preview. */
const SELFIE_PREVIEW_PARENT_DUCK_VOLUME = 0.22;
const SELFIE_PREVIEW_PLAYER_READY_TIMEOUT_MS = 10000;
/**
 * Some Samsung/Android builds emit rapid active↔background AppState transitions when the
 * front camera opens. Treating each blip as a real background unmounts CameraView, which
 * re-triggers the camera and creates a mount/unmount flash loop. Wait this long before
 * acting on background while the selfie sheet is open.
 */
const ANDROID_SELFIE_APPSTATE_BACKGROUND_MS = 900;
/** Continuous active before preview audio on Samsung (camera debounce is longer). */
const ANDROID_PREVIEW_APPSTATE_STABLE_MS = 600;
const ANDROID_PREVIEW_APPSTATE_WAIT_TIMEOUT_MS = 5000;
const ANDROID_PREVIEW_AUDIO_FOCUS_MAX_ATTEMPTS = 4;
const ANDROID_SELFIE_PREVIEW_RESUME_MAX_ATTEMPTS = 5;

async function runPreviewVideoCommandWithRetry(
  command: () => Promise<unknown> | undefined,
  logLabel: string,
): Promise<boolean> {
  if (Platform.OS !== 'android') {
    try {
      await command();
      return true;
    } catch (error) {
      if (isSeekInterrupted(error)) return true;
      console.warn(`[ReactionSheet] ${logLabel}:`, error);
      return false;
    }
  }

  const ok = await runConnectAvCommandWithRetry(
    async () => {
      await command();
    },
    {
      maxAttempts: ANDROID_PREVIEW_AUDIO_FOCUS_MAX_ATTEMPTS,
      stableMs: ANDROID_PREVIEW_APPSTATE_STABLE_MS,
      stableTimeoutMs: ANDROID_PREVIEW_APPSTATE_WAIT_TIMEOUT_MS,
      onRetry: (attempt) => {
        logReactionDebug('selfie-preview:audio-focus-retry', {
          attempt,
          logLabel,
        });
      },
    },
  );
  if (!ok) {
    console.warn(`[ReactionSheet] ${logLabel}: audio focus retries exhausted`);
  }
  return ok;
}

function waitForCompanionSelfiePlayerReady(
  player: VideoPlayer,
  timeoutMs = SELFIE_PREVIEW_PLAYER_READY_TIMEOUT_MS,
): Promise<boolean> {
  try {
    if (player.status === 'readyToPlay') return Promise.resolve(true);
    if (player.status === 'error') return Promise.resolve(false);
  } catch {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      subscription.remove();
      clearTimeout(timer);
      resolve(ready);
    };
    const subscription = player.addListener('statusChange', (payload) => {
      if (payload.status === 'readyToPlay') finish(true);
      if (payload.status === 'error') finish(false);
    });
    const timer = setTimeout(() => {
      try {
        finish(player.status === 'readyToPlay');
      } catch {
        finish(false);
      }
    }, timeoutMs);
  });
}

type ReactionComposeMode = ReactionType;

function isSeekInterrupted(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Seeking interrupted');
}

async function runVideoCommand(
  command: () => Promise<unknown> | undefined,
  logLabel: string,
): Promise<void> {
  try {
    await command();
  } catch (error) {
    if (!isSeekInterrupted(error)) {
      console.warn(`[ReactionSheet] ${logLabel}:`, error);
    }
  }
}

const RECORDING_START_TIMEOUT_MS = 8000;

function logReactionDebug(
  step: string,
  detail?: Record<string, unknown>,
  level: DiagnosticLogLevel = 'log',
): void {
  const safeDetail: Record<string, string | number | boolean | null | undefined> = {};
  if (detail) {
    for (const [key, value] of Object.entries(detail)) {
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        value == null
      ) {
        safeDetail[key] = value;
      }
    }
  }
  diagnosticsAppLog('ReactionSheet', step, safeDetail, level);
}

/** Flip to `false` (or delete this block) to silence compose layout/camera traces.
 *  Logs use [ReactionSheet] prefix. Key steps:
 *  - layout:snapshot / layout:pane — mode UI phase + pane dimensions
 *  - mode:* — mode picker changes
 *  - selfie:* — hold-to-record + PIP camera lifecycle
 *  - typed:* — keyboard + commit
 *  - voice:* — record start/stop pipeline
 */
const REACTION_COMPOSE_DIAG = true;

function logComposeDiag(
  step: string,
  detail?: Record<string, unknown>,
  level: DiagnosticLogLevel = 'log',
): void {
  if (!REACTION_COMPOSE_DIAG) return;
  logReactionDebug(step, detail, level);
}

function logComposePaneLayout(
  pane: 'split' | 'parent' | 'parentSurface' | 'mode',
  width: number,
  height: number,
  mode: ReactionComposeMode,
): void {
  if (!REACTION_COMPOSE_DIAG) return;
  logComposeDiag('layout:pane', {
    pane,
    mode,
    w: Math.round(width),
    h: Math.round(height),
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${label} timed out after ${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function ensureExpoCameraMicPermissionAsync(): Promise<boolean> {
  try {
    const existing = await Camera.getMicrophonePermissionsAsync();
    if (existing.granted) return true;
    if (!existing.canAskAgain) return false;
    const requested = await Camera.requestMicrophonePermissionsAsync();
    return requested.granted;
  } catch (error) {
    console.warn('[ReactionSheet] expo-camera mic permission failed:', error);
    return false;
  }
}

async function ensureMicPermissionAsync(): Promise<boolean> {
  const cameraMicGranted = await ensureExpoCameraMicPermissionAsync();
  if (!cameraMicGranted) return false;

  try {
    const existing = await Audio.getPermissionsAsync();
    if (existing.granted) return true;
    if (!existing.canAskAgain) return false;
  } catch (error) {
    console.warn('[ReactionSheet] expo-av mic permission read failed:', error);
  }

  if (Platform.OS === 'android') {
    try {
      const fromExpoAv = await Audio.requestPermissionsAsync();
      return fromExpoAv.granted;
    } catch (error) {
      console.warn('[ReactionSheet] expo-av mic permission failed:', error);
      return false;
    }
  }

  try {
    const fromExpoAudio = await requestRecordingPermissionsAsync();
    if (fromExpoAudio.granted) return true;
  } catch (error) {
    console.warn('[ReactionSheet] expo-audio mic permission failed:', error);
  }
  try {
    const fromExpoAv = await Audio.requestPermissionsAsync();
    return fromExpoAv.granted;
  } catch (error) {
    console.warn('[ReactionSheet] expo-av mic permission failed:', error);
    return false;
  }
}

async function prepareExpoAvRecordingSessionAsync(): Promise<void> {
  if (Platform.OS === 'android') {
    try {
      await setIsAudioActiveAsync(false);
    } catch {
      /* ignore */
    }
  }
  try {
    await setIsAudioActiveAsync(true);
  } catch (error) {
    console.warn('[ReactionSheet] setIsAudioActiveAsync failed:', error);
  }
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: true,
    playsInSilentModeIOS: true,
    staysActiveInBackground: false,
    shouldDuckAndroid: true,
    playThroughEarpieceAndroid: false,
  });
}

type ExpoAudioVoiceRecorder = Pick<
  ReturnType<typeof useAudioRecorder>,
  'isRecording' | 'stop' | 'prepareToRecordAsync' | 'record' | 'getStatus'
>;

async function startExpoAudioVoiceRecordingAsync(
  recorder: ExpoAudioVoiceRecorder,
  options?: { skipSessionConfigure?: boolean },
): Promise<void> {
  if (!options?.skipSessionConfigure) {
    await configureConnectVoiceReactionRecordingAsync();
  }
  try {
    if (recorder.isRecording) {
      await recorder.stop();
    }
  } catch {
    /* ignore stale stop */
  }
  await setAudioModeAsync({
    allowsRecording: true,
    playsInSilentMode: true,
  });
  await recorder.prepareToRecordAsync();
  recorder.record();
  if (recorder.isRecording) return;
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (recorder.isRecording) return;
  }
  const status = recorder.getStatus();
  throw new Error(
    `Voice recorder did not start (canRecord=${status.canRecord}, isRecording=${status.isRecording}, mediaReset=${status.mediaServicesDidReset})`,
  );
}

async function startAndroidExpoAvVoiceRecordingAsync(options: {
  isVideoParent: boolean;
  trimStartMs: number;
  startParentPlayback?: (startMs: number) => Promise<void>;
}): Promise<Audio.Recording> {
  logComposeDiag('voice:release-capture');
  await releaseConnectCaptureAudioAsync();
  await new Promise((resolve) => setTimeout(resolve, 250));

  logComposeDiag('voice:prepare-session');
  await prepareExpoAvRecordingSessionAsync();

  if (options.isVideoParent && options.startParentPlayback) {
    logComposeDiag('voice:parent-playback', { trimStartMs: options.trimStartMs });
    await options.startParentPlayback(options.trimStartMs);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const recording = new Audio.Recording();
  logComposeDiag('voice:prepare-recording');
  await recording.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
  logComposeDiag('voice:start-recording');
  await recording.startAsync();
  const status = await recording.getStatusAsync();
  logComposeDiag('voice:recording-status', {
    isRecording: status.isRecording,
    canRecord: status.canRecord,
    durationMillis: status.durationMillis,
  });
  if (!status.isRecording) {
    throw new Error(
      `Android voice did not start (isRecording=${status.isRecording}, canRecord=${status.canRecord})`,
    );
  }
  return recording;
}

export type ReactionParentMedia =
  | { mediaType: 'video'; videoUrl: string }
  | { mediaType: 'image'; imageUrl: string };

export interface ReactionSheetProps {
  visible: boolean;
  onClose: () => void;
  parentReflectionId: string;
  parentMedia: ReactionParentMedia | null;
  onUploadSuccess?: (parentReflectionId: string, relationshipId: string) => void;
  /**
   * 'narration' locks the sheet to selfie capture for bringing an image
   * Reflection to life; the take is handed back via onNarrationComplete
   * instead of being uploaded.
   */
  mode?: 'reaction' | 'narration';
  /** Narration mode: receives the recorded selfie video URI. No upload occurs. */
  onNarrationComplete?: (videoUri: string) => void;
}

export function ReactionSheet({
  visible,
  onClose,
  parentReflectionId,
  parentMedia,
  onUploadSuccess,
  mode = 'reaction',
  onNarrationComplete,
}: ReactionSheetProps) {
  const isNarrationMode = mode === 'narration';
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { currentExplorerId, activeRelationship } = useExplorer();
  const { companions } = useCompanionAvatars(currentExplorerId);
  const [resolvedCompanionAvatarUrl, setResolvedCompanionAvatarUrl] = useState<string | null>(null);
  const companionAvatar = useMemo(() => {
    const fromList =
      companions.find((c) => c.userId === user?.uid) ??
      companions.find((c) => c.relationshipId === activeRelationship?.id);
    if (fromList) {
      return { ...fromList, avatarUrl: fromList.avatarUrl ?? resolvedCompanionAvatarUrl };
    }
    if (activeRelationship && user?.uid) {
      return {
        relationshipId: activeRelationship.id,
        userId: user.uid,
        companionName: activeRelationship.companionName || 'Companion',
        role: activeRelationship.role ?? null,
        isCaregiver: activeRelationship.role === 'caregiver',
        avatarUrl: resolvedCompanionAvatarUrl,
        avatarS3Key: activeRelationship.companionAvatarS3Key ?? null,
        color: getAvatarColor(user.uid),
        initial: getAvatarInitial(activeRelationship.companionName || 'Companion'),
      };
    }
    return null;
  }, [activeRelationship, companions, resolvedCompanionAvatarUrl, user?.uid]);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [micReady, setMicReady] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const cameraReadyRef = useRef(false);
  const [isCameraRestoring, setIsCameraRestoring] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isSelfieSaving, setIsSelfieSaving] = useState(false);
  /** Keeps CameraView mounted through press-out until save promise resolves (guards batched state gaps). */
  const [selfieCaptureFinalizePending, setSelfieCaptureFinalizePending] = useState(false);
  const [isSelfieCaptureArming, setIsSelfieCaptureArming] = useState(false);
  const [isSelfieRetakePreparing, setIsSelfieRetakePreparing] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [positionMillis, setPositionMillis] = useState(0);
  const [durationMillis, setDurationMillis] = useState(0);
  const [recordedUri, setRecordedUri] = useState<string | null>(null);
  const [syncStartTimeMillis, setSyncStartTimeMillis] = useState<number | null>(null);
  const [syncEndTimeMillis, setSyncEndTimeMillis] = useState<number | null>(null);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const [trimStartMs, setTrimStartMs] = useState(0);
  const [trimEndMs, setTrimEndMs] = useState(0);
  // Stable key — the selfie CameraView is intentionally never remounted.
  const [cameraInstanceKey] = useState(0);
  const cameraInstanceKeyRef = useRef(0);
  const [isParentReflectionMuted, setIsParentReflectionMuted] = useState(true);
  const [reactionMode, setReactionMode] = useState<ReactionComposeMode>('selfie');
  const [typedMessage, setTypedMessage] = useState('');
  const [voiceRecordedUri, setVoiceRecordedUri] = useState<string | null>(null);
  const [isVoiceRecording, setIsVoiceRecording] = useState(false);
  const [isStartingVoiceRecording, setIsStartingVoiceRecording] = useState(false);
  const [isVoiceProcessing, setIsVoiceProcessing] = useState(false);
  const [nativeCameraGranted, setNativeCameraGranted] = useState<boolean | null>(null);
  // Tracks whether the app is foregrounded for camera session control (`active` prop, ready reset).
  // On Android while the selfie sheet is open, background/inactive AppState blips are debounced so
  // a CameraView mount/unmount loop cannot feed back into more AppState events (Samsung S25 class).
  const [isAppForeground, setIsAppForeground] = useState(true);
  const appStateBackgroundDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [companionPreviewOpen, setCompanionPreviewOpen] = useState(false);
  const [companionPreviewPlaying, setCompanionPreviewPlaying] = useState(false);
  const [showCompanionPreviewReplay, setShowCompanionPreviewReplay] = useState(false);
  const [companionPreviewSendHint, setCompanionPreviewSendHint] = useState(false);
  const [recordedAudioSnapshot, setRecordedAudioSnapshot] =
    useState<SelfieRecordingAudioSnapshot | null>(null);
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  const retakeReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const voiceRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const voiceExpoAvRecordingRef = useRef<Audio.Recording | null>(null);
  const isStartingVoiceRecordingRef = useRef(false);
  const companionPreviewStopPendingRef = useRef(false);
  const companionPreviewAutoStartDoneRef = useRef(false);
  const companionPreviewStartInFlightRef = useRef(false);
  const companionPreviewPlayingRef = useRef(false);
  const selfieCaptureArmingRef = useRef(false);
  const visibleRef = useRef(visible);
  const companionPreviewOpenRef = useRef(companionPreviewOpen);
  const isUploadingRef = useRef(false);
  // Selfie preview interruption recovery. On iOS old-arch, expo-camera's deferred AVCaptureSession
  // teardown calls AVAudioSession.setActive(false) ~0.6-1s after we open the preview, which
  // interrupts (pauses) the expo-video player mid-clip. We can't out-time that teardown from JS, so
  // we recover from it: if the player pauses unexpectedly while we expect it to be playing, we
  // restart it once or twice. This is the documented iOS interruption-recovery pattern, not a poll.
  const selfiePreviewExpectPlayingRef = useRef(false);
  const selfiePreviewResumeAttemptsRef = useRef(0);
  const selfiePreviewLastResumePosRef = useRef(0);
  const selfiePreviewResumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Live audio output route. Headphones/Bluetooth → the parent Reflection can play out loud during
  // recording (no echo path); otherwise we fall back to the platform echo policy.
  const audioRoute = useAudioRoute(visible);
  const hasHeadphones = audioRoute.hasHeadphones;

  const isVideoParent = parentMedia?.mediaType === 'video';
  const isImageParent = parentMedia?.mediaType === 'image';
  const parentVideoUrl = parentMedia?.mediaType === 'video' ? parentMedia.videoUrl : '';
  const parentImageUrl = parentMedia?.mediaType === 'image' ? parentMedia.imageUrl : '';
  const hasValidParentMedia =
    (isVideoParent && !!parentVideoUrl) || (isImageParent && !!parentImageUrl);
  const parentPosterUri = isVideoParent ? parentVideoUrl : parentImageUrl;

  const videoRef = useRef<Video>(null);
  const companionParentRef = useRef<Video>(null);
  const cameraRef = useRef<CameraView>(null);

  // Companion selfie preview is played via expo-video (the stable SDK 52 player). Unlike the
  // deprecated expo-av Video, it owns its own AVAudioSession activation, so it starts reliably
  // after camera capture without the manual session-healing the old player required. The source
  // is null unless we're previewing a recorded selfie; useVideoPlayer swaps the source when it
  // changes (e.g. after a retake).
  const companionSelfieSource = useMemo<VideoSource>(
    () => (reactionMode === 'selfie' && recordedUri ? { uri: ensureFileUri(recordedUri) } : null),
    [reactionMode, recordedUri],
  );
  const companionSelfiePlayer = useVideoPlayer(companionSelfieSource, (player) => {
    player.loop = false;
    player.muted = false;
    player.volume = 1.0;
    player.timeUpdateEventInterval = 0;
    // Default to mixing — this is what Android needs and was working with. On iOS this is overridden
    // per-parent at play time (see startCompanionPreview): exclusive ('auto') for image parents so
    // the selfie plays at full volume, mixing for video parents so it coexists with the parent.
    player.audioMixingMode = 'mixWithOthers';
  });
  const recordingPromiseRef = useRef<Promise<{ uri: string } | undefined> | null>(null);
  const recordSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingStartedAtRef = useRef(0);
  const cameraRecordingStartedRef = useRef(false);
  const parentVideoWidthRef = useRef(0);
  const seekOriginMsRef = useRef(0);
  const durationMillisRef = useRef(0);
  const trimStartMsRef = useRef(0);
  const trimEndMsRef = useRef(0);
  const positionMillisRef = useRef(0);
  const canScrubRef = useRef(true);
  const isScrubbingRef = useRef(false);
  const isVideoDragActiveRef = useRef(false);
  const previewStopPendingRef = useRef(false);
  const seekChainRef = useRef(Promise.resolve());
  const pendingSeekTargetRef = useRef<number | null>(null);
  const isParentReflectionMutedRef = useRef(false);
  const isPreviewPlayingRef = useRef(false);
  const parentPreviewToggleBusyRef = useRef(false);
  const lastPanSeekAtRef = useRef(0);
  const lastParentVolumeApplyRef = useRef(0);
  const lastCompanionParentVolumeApplyRef = useRef(0);
  const hasHeadphonesRef = useRef(false);
  // True once the Companion manually toggles mute-while-recording, so we stop applying the smart default.
  const userToggledMuteRef = useRef(false);
  const isRecordingRef = useRef(false);
  const recordingSessionIdRef = useRef(0);
  const recordingAudioReassertCancelRef = useRef<(() => void) | null>(null);
  const voicePreviewPlayerRef = useRef<Audio.Sound | null>(null);
  const typedPreviewAudioUriRef = useRef<string | null>(null);
  const typedPreviewMessageRef = useRef<string | null>(null);
  const [isTypedKeyboardVisible, setIsTypedKeyboardVisible] = useState(false);
  const [typedMessageReady, setTypedMessageReady] = useState(false);
  const [typedPreviewLoading, setTypedPreviewLoading] = useState(false);
  const stopSelfieRecordingRef = useRef<(() => void) | null>(null);
  const layoutUiPhaseRef = useRef<string | null>(null);

  const isParentMutedForPlayback = useCallback(
    () => isRecordingRef.current && isParentReflectionMutedRef.current,
    [],
  );

  const getReactionParentVolume = useCallback(
    () =>
      resolveReactionRecordingVolume({
        muted: isParentMutedForPlayback(),
        hasHeadphones: hasHeadphonesRef.current,
      }),
    [isParentMutedForPlayback],
  );

  /** Parent Reflection volume while trim/companion preview is actively playing (not recording). */
  const getParentPreviewPlaybackVolume = useCallback(
    () =>
      resolveReactionRecordingVolume({
        muted: false,
        hasHeadphones: hasHeadphonesRef.current,
      }),
    [],
  );

  const getCompanionPreviewParentVolume = useCallback(() => {
    const baseVolume = getParentPreviewPlaybackVolume();
    return reactionMode === 'selfie'
      ? Math.min(baseVolume, SELFIE_PREVIEW_PARENT_DUCK_VOLUME)
      : baseVolume;
  }, [getParentPreviewPlaybackVolume, reactionMode]);

  /** Keep expo-av mute flag and volume in sync — setStatusAsync(volume) alone clears isMuted. */
  const syncParentVideoAudioAsync = useCallback(
    async (
      target: Video | null | undefined,
      options?: { previewPlayback?: boolean },
    ) => {
      if (!target) return;
      const status = await target.getStatusAsync().catch(() => null);
      if (!status?.isLoaded) return;
      const previewPlayback = options?.previewPlayback === true;
      const muted = previewPlayback ? false : isParentMutedForPlayback();
      const volume = previewPlayback ? getParentPreviewPlaybackVolume() : getReactionParentVolume();
      await runVideoCommand(async () => {
        await target.setIsMutedAsync(muted);
        await target.setVolumeAsync(volume);
      }, 'failed to sync parent audio');
    },
    [getParentPreviewPlaybackVolume, getReactionParentVolume, isParentMutedForPlayback],
  );

  const applyParentReflectionVolume = useCallback(async () => {
    const previewPlayback = isPreviewPlayingRef.current && !isRecordingRef.current;
    await syncParentVideoAudioAsync(videoRef.current, { previewPlayback });
  }, [syncParentVideoAudioAsync]);

  const startParentRecordingPlayback = useCallback(
    async (startMs: number, options?: { seek?: boolean }) => {
      if (!isVideoParent) return;
      const muted = isParentReflectionMutedRef.current;
      const volume = getReactionParentVolume();
      const seek = options?.seek ?? true;
      await syncParentVideoAudioAsync(videoRef.current);
      const playCommand = async () => {
        await videoRef.current?.setStatusAsync({
          // Reasserts (seek:false) only re-confirm play/volume/mute so the audio
          // session settles — they must NOT yank the playhead back to syncStart,
          // which made the scrubber "dance" during recording.
          ...(seek ? { positionMillis: startMs } : {}),
          shouldPlay: true,
          isMuted: muted,
          volume,
        });
      };
      if (Platform.OS === 'android') {
        const ok = await runConnectAvCommandWithRetry(playCommand, {
          stableMs: ANDROID_PREVIEW_APPSTATE_STABLE_MS,
          stableTimeoutMs: ANDROID_PREVIEW_APPSTATE_WAIT_TIMEOUT_MS,
          onRetry: (attempt) => {
            logComposeDiag('selfie:parent-sync-retry', { attempt });
          },
        });
        if (!ok) {
          console.warn('[ReactionSheet] reaction playback failed: audio focus retries exhausted');
        }
        return;
      }
      await runVideoCommand(playCommand, 'reaction playback failed');
    },
    [getReactionParentVolume, isVideoParent, syncParentVideoAudioAsync],
  );

  const getParentPreviewStartMs = useCallback(() => {
    if (reactionMode === 'selfie') {
      return syncStartTimeMillis ?? trimStartMsRef.current ?? 0;
    }
    return trimStartMsRef.current;
  }, [reactionMode, syncStartTimeMillis]);

  const unloadPreviewAudio = useCallback(async () => {
    const sound = voicePreviewPlayerRef.current;
    voicePreviewPlayerRef.current = null;
    if (!sound) return;
    try {
      await sound.stopAsync();
    } catch {
      /* ignore */
    }
    try {
      await sound.unloadAsync();
    } catch {
      /* ignore */
    }
  }, []);

  const playCompanionPreviewClip = useCallback(
    async (uri: string, onFinished: () => void) => {
      await unloadPreviewAudio();
      await configureConnectPlaybackAudioSessionAsync({ retries: 2 });
      const loadAndPlay = async () => {
        const { sound } = await Audio.Sound.createAsync(
          { uri: ensureFileUri(uri) },
          { shouldPlay: true, volume: 1.0 },
        );
        voicePreviewPlayerRef.current = sound;
        sound.setOnPlaybackStatusUpdate((status) => {
          if (!status.isLoaded || !status.didJustFinish) return;
          if (voicePreviewPlayerRef.current === sound) {
            voicePreviewPlayerRef.current = null;
          }
          void sound.unloadAsync().catch(() => {});
          onFinished();
        });
      };
      if (Platform.OS === 'android') {
        const ok = await runConnectAvCommandWithRetry(loadAndPlay, {
          stableMs: ANDROID_PREVIEW_APPSTATE_STABLE_MS,
          stableTimeoutMs: ANDROID_PREVIEW_APPSTATE_WAIT_TIMEOUT_MS,
        });
        if (!ok) {
          throw new Error('Preview audio could not start');
        }
        return;
      }
      await loadAndPlay();
    },
    [unloadPreviewAudio],
  );

  const restoreReactionRecordingAudioSession = useCallback(async () => {
    try {
      await configureConnectReactionRecordingAudioSessionAsync();
    } catch (error) {
      console.warn('[ReactionSheet] failed to restore recording audio session:', error);
    }
  }, []);

  const getCompanionPreviewBlockedReason = useCallback((): string | null => {
    if (!visibleRef.current) return 'sheet-not-visible';
    if (!companionPreviewOpenRef.current) return 'preview-overlay-closed';
    if (companionPreviewStopPendingRef.current) return 'stop-pending';
    return null;
  }, []);

  const canRunCompanionPreview = useCallback(() => {
    return getCompanionPreviewBlockedReason() == null;
  }, [getCompanionPreviewBlockedReason]);

  const logPreviewStartSkipped = useCallback(
    (reason: string, detail?: Record<string, string | number | boolean | null | undefined>) => {
      logReactionDebug(
        'selfie-preview:start-skipped',
        { reason, platform: Platform.OS, ...detail },
        'warn',
      );
    },
    [],
  );

  const finishCompanionPreview = useCallback(async (options?: { playbackFailed?: boolean }) => {
    if (companionPreviewStopPendingRef.current) return;
    logReactionDebug('selfie-preview:finish', {
      playbackFailed: options?.playbackFailed ?? false,
    });
    selfiePreviewExpectPlayingRef.current = false;
    if (selfiePreviewResumeTimerRef.current) {
      clearTimeout(selfiePreviewResumeTimerRef.current);
      selfiePreviewResumeTimerRef.current = null;
    }
    companionPreviewStopPendingRef.current = true;
    companionPreviewPlayingRef.current = false;
    setCompanionPreviewPlaying(false);
    try {
      companionSelfiePlayer.pause();
    } catch {
      /* player may be released */
    }
    await unloadPreviewAudio();
    await runVideoCommand(() => companionParentRef.current?.pauseAsync(), 'companion preview pause failed');
    const parentPreviewStartMs = getParentPreviewStartMs();
    if (isVideoParent && parentPreviewStartMs != null) {
      await runVideoCommand(
        () =>
          companionParentRef.current?.setStatusAsync({
            positionMillis: parentPreviewStartMs,
            shouldPlay: false,
            isMuted: true,
            volume: 0,
          }),
        'companion preview reset failed',
      );
    }
    companionPreviewStopPendingRef.current = false;
    if (options?.playbackFailed) {
      setCompanionPreviewSendHint(true);
    }
    setShowCompanionPreviewReplay(true);
  }, [
    companionSelfiePlayer,
    getParentPreviewStartMs,
    isVideoParent,
    unloadPreviewAudio,
  ]);

  /** Stop preview/camera before upload so Android is not decoding thumbnails while capture is live. */
  const prepareReactionForUpload = useCallback(async (mode: ReactionComposeMode) => {
    logComposeDiag('reaction:send-prepare-start', { mode, platform: Platform.OS });

    selfiePreviewExpectPlayingRef.current = false;
    companionPreviewStopPendingRef.current = true;
    companionPreviewStartInFlightRef.current = false;
    companionPreviewAutoStartDoneRef.current = false;
    if (selfiePreviewResumeTimerRef.current) {
      clearTimeout(selfiePreviewResumeTimerRef.current);
      selfiePreviewResumeTimerRef.current = null;
    }

    setCompanionPreviewPlaying(false);
    companionPreviewPlayingRef.current = false;
    setShowCompanionPreviewReplay(false);
    setCompanionPreviewSendHint(false);
    setCompanionPreviewOpen(false);
    companionPreviewOpenRef.current = false;

    try {
      companionSelfiePlayer.pause();
    } catch {
      /* player may be released */
    }
    await unloadPreviewAudio();
    await runVideoCommand(() => companionParentRef.current?.pauseAsync(), 'send prepare parent pause');
    await runVideoCommand(() => videoRef.current?.pauseAsync(), 'send prepare video pause');

    if (mode === 'selfie') {
      try {
        cameraRef.current?.stopRecording();
      } catch {
        /* not recording */
      }
      await releaseConnectCaptureAudioAsync();
      if (Platform.OS === 'android') {
        await waitForStableAndroidAppForeground(400, 3000);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } else if (Platform.OS === 'android') {
      await waitForStableAndroidAppForeground(400, 2000);
    }

    logComposeDiag('reaction:send-prepare-done', { mode, platform: Platform.OS });
  }, [companionSelfiePlayer, unloadPreviewAudio]);

  // Selfie preview finishes when expo-video reports it played to the end. The stop-pending guard
  // inside finishCompanionPreview de-dupes with the parent-driven finish for video parents.
  useEffect(() => {
    const subscription = companionSelfiePlayer.addListener('playToEnd', () => {
      void finishCompanionPreview();
    });
    return () => subscription.remove();
  }, [companionSelfiePlayer, finishCompanionPreview]);

  const finishCompanionPreviewRef = useRef(finishCompanionPreview);
  useEffect(() => {
    finishCompanionPreviewRef.current = finishCompanionPreview;
  }, [finishCompanionPreview]);

  // Diagnostic instrumentation for the selfie preview player. expo-video emits these only on
  // transitions, so they are low-noise. statusChange surfaces readyToPlay/error; playingChange
  // confirms whether the AVPlayer actually started (vs. hanging on a frozen first frame).
  useEffect(() => {
    const statusSub = companionSelfiePlayer.addListener('statusChange', (payload) => {
      logReactionDebug('selfie-preview:player-status', {
        status: payload.status,
        oldStatus: payload.oldStatus,
        error: payload.error?.message,
      });
    });
    const playingSub = companionSelfiePlayer.addListener('playingChange', (payload) => {
      let currentTime: number | undefined;
      let duration: number | undefined;
      try {
        currentTime = companionSelfiePlayer.currentTime;
        duration = companionSelfiePlayer.duration;
      } catch {
        /* player may be released */
      }
      logReactionDebug('selfie-preview:player-playing', {
        isPlaying: payload.isPlaying,
        currentTime,
        duration,
      });

      // Recover when playback stalls after we asked the player to start. iOS: expo-camera's
      // deferred AVCaptureSession teardown interrupts mid-clip — resume from current position.
      // Android: play() is often called before ExoPlayer is ready or while capture audio is still
      // active — retry from the top after releasing the session.
      if (payload.isPlaying) return;
      if (!selfiePreviewExpectPlayingRef.current) return;
      if (companionPreviewStopPendingRef.current) return;
      if (!companionPreviewPlayingRef.current) return;
      const dur = typeof duration === 'number' ? duration : 0;
      const pos = typeof currentTime === 'number' ? currentTime : 0;
      const reachedEnd = dur > 0 && pos >= dur - 0.35;
      if (reachedEnd) return;

      if (Platform.OS === 'android') {
        if (pos > 0.35) return;
      } else if (pos > selfiePreviewLastResumePosRef.current + 0.4) {
        selfiePreviewResumeAttemptsRef.current = 0;
      }
      selfiePreviewLastResumePosRef.current = pos;

      const maxResumeAttempts =
        Platform.OS === 'android'
          ? ANDROID_SELFIE_PREVIEW_RESUME_MAX_ATTEMPTS
          : 3;

      if (selfiePreviewResumeAttemptsRef.current >= maxResumeAttempts) {
        logReactionDebug('selfie-preview:resume-giveup', { pos, dur, platform: Platform.OS });
        void finishCompanionPreviewRef.current({ playbackFailed: true });
        return;
      }
      selfiePreviewResumeAttemptsRef.current += 1;
      logReactionDebug('selfie-preview:resume', {
        attempt: selfiePreviewResumeAttemptsRef.current,
        pos,
        dur,
        platform: Platform.OS,
      });
      if (selfiePreviewResumeTimerRef.current) {
        clearTimeout(selfiePreviewResumeTimerRef.current);
      }
      selfiePreviewResumeTimerRef.current = setTimeout(() => {
        selfiePreviewResumeTimerRef.current = null;
        if (
          !selfiePreviewExpectPlayingRef.current ||
          companionPreviewStopPendingRef.current ||
          !visibleRef.current ||
          !companionPreviewOpenRef.current
        ) {
          return;
        }
        void (async () => {
          if (Platform.OS === 'android') {
            await waitForStableAndroidAppForeground(
              ANDROID_PREVIEW_APPSTATE_STABLE_MS,
              ANDROID_PREVIEW_APPSTATE_WAIT_TIMEOUT_MS,
            );
            await releaseConnectCaptureAudioAsync();
          }
          if (
            !selfiePreviewExpectPlayingRef.current ||
            companionPreviewStopPendingRef.current ||
            !visibleRef.current ||
            !companionPreviewOpenRef.current
          ) {
            return;
          }
          try {
            if (Platform.OS === 'android') {
              companionSelfiePlayer.currentTime = 0;
            }
            companionSelfiePlayer.play();
          } catch {
            /* player may be released */
          }
        })();
      }, Platform.OS === 'android' ? 280 : 140);
    });
    return () => {
      statusSub.remove();
      playingSub.remove();
    };
  }, [companionSelfiePlayer]);

  const startCompanionPreview = useCallback(async () => {
    const blockedReason = getCompanionPreviewBlockedReason();
    if (blockedReason) {
      logPreviewStartSkipped(blockedReason);
      return;
    }
    if (companionPreviewStartInFlightRef.current) {
      logPreviewStartSkipped('start-in-flight');
      return;
    }
    if (companionPreviewPlayingRef.current && !showCompanionPreviewReplay) {
      logPreviewStartSkipped('already-playing');
      return;
    }

    const isSelfiePreview = reactionMode === 'selfie' && !!recordedUri;
    const isVoicePreview = reactionMode === 'voice' && !!voiceRecordedUri;
    const isTypedPreview = reactionMode === 'typed' && !!typedMessage.trim();
    if (!isSelfiePreview && !isVoicePreview && !isTypedPreview) {
      logPreviewStartSkipped('no-previewable-content', { reactionMode });
      return;
    }

    companionPreviewStartInFlightRef.current = true;
    setCompanionPreviewSendHint(false);
    const abortIfPreviewBlocked = (phase: string): boolean => {
      const reason = getCompanionPreviewBlockedReason();
      if (!reason) return false;
      logReactionDebug(
        'selfie-preview:aborted',
        { phase, reason, platform: Platform.OS },
        'warn',
      );
      companionPreviewPlayingRef.current = false;
      setCompanionPreviewPlaying(false);
      companionPreviewAutoStartDoneRef.current = false;
      return true;
    };
    try {
      logReactionDebug('selfie-preview:enter', {
        isSelfiePreview,
        isVoicePreview,
        isTypedPreview,
      });
      companionPreviewAutoStartDoneRef.current = true;

    if (Platform.OS === 'android') {
      const stable = await waitForStableAndroidAppForeground(
        ANDROID_PREVIEW_APPSTATE_STABLE_MS,
        ANDROID_PREVIEW_APPSTATE_WAIT_TIMEOUT_MS,
      );
      logReactionDebug('selfie-preview:appstate-wait', { stable, platform: 'android' });
    }

    companionPreviewPlayingRef.current = true;
    setCompanionPreviewPlaying(true);
    setShowCompanionPreviewReplay(false);
    companionPreviewStopPendingRef.current = false;

    const parentPreviewPlaybackVolume = getCompanionPreviewParentVolume();
    const parentPreviewStartMs = getParentPreviewStartMs();

    try {
      await configureConnectPlaybackAudioSessionAsync({ retries: 2 });
    } catch (error) {
      console.warn('[ReactionSheet] preview audio session failed:', error);
    }
    if (abortIfPreviewBlocked('after-audio-session')) return;

    const deferParentForAndroidSelfie =
      Platform.OS === 'android' &&
      isSelfiePreview &&
      isVideoParent &&
      parentPreviewStartMs != null;

    const startCompanionPreviewParent = async (): Promise<boolean> => {
      if (!isVideoParent || parentPreviewStartMs == null) return true;
      return runPreviewVideoCommandWithRetry(
        () =>
          companionParentRef.current?.setStatusAsync({
            positionMillis: parentPreviewStartMs,
            shouldPlay: true,
            isMuted: false,
            volume: parentPreviewPlaybackVolume,
          }),
        'failed to start companion preview',
      );
    };

    if (!deferParentForAndroidSelfie) {
      const parentStarted = await startCompanionPreviewParent();
      if (!parentStarted && Platform.OS === 'android' && isSelfiePreview) {
        logReactionDebug('selfie-preview:parent-start-failed', { isVideoParent }, 'warn');
      }
    }
    if (abortIfPreviewBlocked('before-selfie-pipeline')) return;

    if (isSelfiePreview) {
      // Camera capture keeps the audio session in recording mode on both platforms until we
      // explicitly release it. iOS also needs mixing-mode setup; Android often loses audio focus
      // to expo-av if the parent starts before ExoPlayer is ready (parent start is deferred above).
      await releaseConnectCaptureAudioAsync();
      if (abortIfPreviewBlocked('after-release-capture-audio')) return;

      if (Platform.OS === 'ios') {
        if (isVideoParent) {
          // Video parent: the parent video is also playing, so the selfie must coexist with it.
          try {
            companionSelfiePlayer.audioMixingMode = 'mixWithOthers';
          } catch (error) {
            if (abortIfPreviewBlocked('ios-video-mixing-mode')) return;
            console.warn('[ReactionSheet] selfie preview player unavailable:', error);
            selfiePreviewExpectPlayingRef.current = false;
            setCompanionPreviewPlaying(false);
            setShowCompanionPreviewReplay(true);
            return;
          }
        } else {
          // Image parent: nothing else needs audio, so give expo-video an exclusive, full-volume
          // session instead of mixing/ducking. Release our own expo-audio playback session (just
          // re-activated by releaseConnectCaptureAudioAsync) first.
          try {
            await setIsAudioActiveAsync(false);
          } catch {
            /* best effort: if our session was not active, expo-video still owns playback */
          }
          // Brief settle so the deactivation lands before expo-video activates its own session.
          await new Promise((resolve) => setTimeout(resolve, 120));
          if (abortIfPreviewBlocked('ios-image-audio-settle')) return;
          try {
            companionSelfiePlayer.audioMixingMode = 'auto';
          } catch (error) {
            if (abortIfPreviewBlocked('ios-image-mixing-mode')) return;
            console.warn('[ReactionSheet] selfie preview player unavailable:', error);
            selfiePreviewExpectPlayingRef.current = false;
            setCompanionPreviewPlaying(false);
            setShowCompanionPreviewReplay(true);
            return;
          }
        }
      } else if (isVideoParent) {
        try {
          companionSelfiePlayer.audioMixingMode = 'mixWithOthers';
        } catch (error) {
          if (abortIfPreviewBlocked('android-video-mixing-mode')) return;
          console.warn('[ReactionSheet] selfie preview player unavailable:', error);
          selfiePreviewExpectPlayingRef.current = false;
          setCompanionPreviewPlaying(false);
          setShowCompanionPreviewReplay(true);
          return;
        }
      }
      // Arm interruption recovery before starting: playingChange will retry if capture teardown or
      // an early play() race leaves the clip stalled at the start.
      selfiePreviewResumeAttemptsRef.current = 0;
      selfiePreviewLastResumePosRef.current = 0;
      try {
        companionSelfiePlayer.pause();
        companionSelfiePlayer.currentTime = 0;
      } catch (error) {
        if (abortIfPreviewBlocked('player-reset')) return;
        console.warn('[ReactionSheet] selfie preview player reset failed:', error);
        selfiePreviewExpectPlayingRef.current = false;
        setCompanionPreviewPlaying(false);
        setShowCompanionPreviewReplay(true);
        return;
      }

      const playerReady = await waitForCompanionSelfiePlayerReady(companionSelfiePlayer);
      if (!playerReady) {
        logReactionDebug('selfie-preview:not-ready', { isVideoParent });
      }
      if (abortIfPreviewBlocked('before-play')) return;

      selfiePreviewExpectPlayingRef.current = true;
      try {
        if (Platform.OS === 'android') {
          await waitForStableAndroidAppForeground(400, 2500);
        }
        companionSelfiePlayer.play();
        logReactionDebug('selfie-preview:start', { isVideoParent, playerReady });
      } catch (error) {
        if (abortIfPreviewBlocked('play-threw')) return;
        console.warn('[ReactionSheet] selfie preview playback failed:', error);
        selfiePreviewExpectPlayingRef.current = false;
        setCompanionPreviewPlaying(false);
        setCompanionPreviewSendHint(true);
        setShowCompanionPreviewReplay(true);
        if (isVideoParent) {
          await runVideoCommand(
            () => companionParentRef.current?.pauseAsync(),
            'companion preview pause failed',
          );
        }
        return;
      }

      if (deferParentForAndroidSelfie) {
        const parentStarted = await startCompanionPreviewParent();
        if (!parentStarted) {
          logReactionDebug('selfie-preview:parent-start-failed', { isVideoParent }, 'warn');
        }
      }
    }

    if (isVoicePreview && voiceRecordedUri) {
      try {
        await playCompanionPreviewClip(voiceRecordedUri, () => {
          void finishCompanionPreview();
        });
      } catch (error) {
        console.warn('[ReactionSheet] voice preview playback failed:', error);
        setCompanionPreviewPlaying(false);
      }
    }

    if (isTypedPreview) {
      if (!currentExplorerId) {
        setCompanionPreviewPlaying(false);
        Alert.alert('Explorer Not Ready', 'Please wait for the Explorer profile to load before previewing.');
        return;
      }
      setTypedPreviewLoading(true);
      try {
        const trimmed = typedMessage.trim();
        const companionName = companionAvatar?.companionName || 'Companion';
        const spokenPreviewKey = formatTypedReactionSpeechText(companionName, trimmed);
        let audioUri = typedPreviewAudioUriRef.current;
        if (typedPreviewMessageRef.current !== spokenPreviewKey || !audioUri) {
          const { captionVoice } = await loadVoicePreferences();
          audioUri = await generateTypedReactionAudio(
            trimmed,
            currentExplorerId,
            captionVoice,
            companionName,
          );
          typedPreviewAudioUriRef.current = audioUri;
          typedPreviewMessageRef.current = spokenPreviewKey;
        }
        await playCompanionPreviewClip(audioUri, () => {
          void finishCompanionPreview();
        });
      } catch (error) {
        console.warn('[ReactionSheet] typed preview TTS failed:', error);
        setCompanionPreviewPlaying(false);
        Alert.alert(
          'Preview Unavailable',
          'Could not generate AI voice for your message. Please try again.',
        );
      } finally {
        setTypedPreviewLoading(false);
      }
    }
    } finally {
      companionPreviewStartInFlightRef.current = false;
    }
  }, [
    companionAvatar?.companionName,
    companionSelfiePlayer,
    currentExplorerId,
    finishCompanionPreview,
    getCompanionPreviewBlockedReason,
    getCompanionPreviewParentVolume,
    getParentPreviewStartMs,
    isVideoParent,
    logPreviewStartSkipped,
    playCompanionPreviewClip,
    reactionMode,
    recordedUri,
    showCompanionPreviewReplay,
    typedMessage,
    voiceRecordedUri,
  ]);

  const kickCompanionPreviewStart = useCallback(
    (source: 'record-complete' | 'preview-button' | 'effect-retry') => {
      companionPreviewAutoStartDoneRef.current = false;
      companionPreviewStopPendingRef.current = false;
      companionPreviewOpenRef.current = true;
      logComposeDiag('selfie-preview:schedule', { source, platform: Platform.OS });
      setCompanionPreviewOpen(true);
      queueMicrotask(() => {
        void startCompanionPreview();
      });
    },
    [startCompanionPreview],
  );

  const replayCompanionPreview = useCallback(() => {
    setShowCompanionPreviewReplay(false);
    companionPreviewStopPendingRef.current = false;
    companionPreviewPlayingRef.current = false;
    companionPreviewStartInFlightRef.current = false;
    companionPreviewAutoStartDoneRef.current = false;
    void startCompanionPreview();
  }, [startCompanionPreview]);

  const openHowItWorks = useCallback(() => setIsInfoOpen(true), []);
  const closeHowItWorks = useCallback(() => setIsInfoOpen(false), []);

  const openCompanionPreview = useCallback(() => {
    kickCompanionPreviewStart('preview-button');
  }, [kickCompanionPreviewStart]);

  const closeCompanionPreview = useCallback(() => {
    selfiePreviewExpectPlayingRef.current = false;
    companionPreviewAutoStartDoneRef.current = false;
    companionPreviewOpenRef.current = false;
    setCompanionPreviewOpen(false);
    companionPreviewPlayingRef.current = false;
    setCompanionPreviewPlaying(false);
    setShowCompanionPreviewReplay(false);
    setCompanionPreviewSendHint(false);
    companionPreviewStopPendingRef.current = false;
    setTypedPreviewLoading(false);
    try {
      companionSelfiePlayer.pause();
    } catch {
      /* player may be released */
    }
    void companionParentRef.current?.pauseAsync().catch(() => {});
    void (async () => {
      await unloadPreviewAudio();
      await restoreReactionRecordingAudioSession();
    })();
  }, [companionSelfiePlayer, restoreReactionRecordingAudioSession, unloadPreviewAudio]);

  const startCompanionPreviewRef = useRef(startCompanionPreview);
  const kickCompanionPreviewStartRef = useRef(kickCompanionPreviewStart);
  useEffect(() => {
    startCompanionPreviewRef.current = startCompanionPreview;
    kickCompanionPreviewStartRef.current = kickCompanionPreviewStart;
  }, [kickCompanionPreviewStart, startCompanionPreview]);

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    companionPreviewOpenRef.current = companionPreviewOpen;
  }, [companionPreviewOpen]);

  useEffect(() => {
    companionPreviewPlayingRef.current = companionPreviewPlaying;
  }, [companionPreviewPlaying]);

  const handleAbandonReaction = useCallback(() => {
    if (isUploading) return;
    selfiePreviewExpectPlayingRef.current = false;
    companionPreviewStopPendingRef.current = true;
    companionPreviewAutoStartDoneRef.current = false;
    if (selfiePreviewResumeTimerRef.current) {
      clearTimeout(selfiePreviewResumeTimerRef.current);
      selfiePreviewResumeTimerRef.current = null;
    }
    companionPreviewOpenRef.current = false;
    setCompanionPreviewOpen(false);
    setCompanionPreviewPlaying(false);
    setShowCompanionPreviewReplay(false);
    setCompanionPreviewSendHint(false);
    setTypedPreviewLoading(false);
    typedPreviewAudioUriRef.current = null;
    typedPreviewMessageRef.current = null;
    void unloadPreviewAudio();
    try {
      companionSelfiePlayer.pause();
    } catch {
      /* player may be released */
    }
    void companionParentRef.current?.pauseAsync().catch(() => {});
    void videoRef.current?.pauseAsync().catch(() => {});
    onClose();
  }, [companionSelfiePlayer, isUploading, onClose, unloadPreviewAudio]);

  useEffect(() => {
    if (!companionPreviewOpen || !visible) {
      companionPreviewAutoStartDoneRef.current = false;
      if (!companionPreviewOpen) {
        companionPreviewOpenRef.current = false;
      }
      return;
    }
    if (companionPreviewAutoStartDoneRef.current || showCompanionPreviewReplay) return;
    if (companionPreviewPlayingRef.current || companionPreviewStartInFlightRef.current) return;

    const hasPreviewableContent =
      (reactionMode === 'selfie' && !!recordedUri) ||
      (reactionMode === 'voice' && !!voiceRecordedUri) ||
      (reactionMode === 'typed' && !!typedMessage.trim());
    if (!hasPreviewableContent) return;

    logComposeDiag('selfie-preview:effect-retry', { platform: Platform.OS });
    queueMicrotask(() => {
      void startCompanionPreviewRef.current();
    });
  }, [
    companionPreviewOpen,
    visible,
    reactionMode,
    recordedUri,
    typedMessage,
    voiceRecordedUri,
    showCompanionPreviewReplay,
  ]);

  const handleCompanionParentStatusUpdate = useCallback(
    (status: AVPlaybackStatus) => {
      if (!status.isLoaded || !companionPreviewOpen || !companionPreviewPlaying || !isVideoParent) {
        return;
      }
      const now = Date.now();
      const parentPreviewPlaybackVolume = getCompanionPreviewParentVolume();
      if (now - lastCompanionParentVolumeApplyRef.current >= 200) {
        lastCompanionParentVolumeApplyRef.current = now;
        void companionParentRef.current
          ?.setIsMutedAsync(false)
          .then(() => companionParentRef.current?.setVolumeAsync(parentPreviewPlaybackVolume))
          .catch(() => {});
      }
      if (!status.isPlaying) return;
      const parentPreviewStartMs = getParentPreviewStartMs();
      if (parentPreviewStartMs == null) return;
      const previewEndMs =
        reactionMode === 'selfie' && syncEndTimeMillis != null
          ? syncEndTimeMillis
          : parentPreviewStartMs + (status.durationMillis ?? durationMillisRef.current);
      if (
        reactionMode === 'selfie' &&
        previewEndMs > parentPreviewStartMs &&
        status.positionMillis >= previewEndMs - PREVIEW_END_EPSILON_MS
      ) {
        void finishCompanionPreview();
      }
    },
    [
      companionPreviewOpen,
      companionPreviewPlaying,
      finishCompanionPreview,
      getCompanionPreviewParentVolume,
      getParentPreviewStartMs,
      isVideoParent,
      reactionMode,
      syncEndTimeMillis,
    ],
  );

  const SEEK_TOLERANCE = useMemo(
    () => ({ toleranceMillisBefore: 0, toleranceMillisAfter: 0 }),
    [],
  );

  useEffect(() => {
    durationMillisRef.current = durationMillis;
  }, [durationMillis]);

  useEffect(() => {
    positionMillisRef.current = positionMillis;
  }, [positionMillis]);

  useEffect(() => {
    trimStartMsRef.current = trimStartMs;
  }, [trimStartMs]);

  useEffect(() => {
    trimEndMsRef.current = trimEndMs;
  }, [trimEndMs]);

  useEffect(() => {
    isParentReflectionMutedRef.current = isParentReflectionMuted;
  }, [isParentReflectionMuted]);

  useEffect(() => {
    hasHeadphonesRef.current = hasHeadphones;
  }, [hasHeadphones]);

  // Default mute-while-recording: off with headphones, on on speaker.
  useEffect(() => {
    if (!visible || userToggledMuteRef.current) return;
    const enabled = defaultReactionOriginalAudioEnabled({ hasHeadphones });
    setIsParentReflectionMuted(!enabled);
    isParentReflectionMutedRef.current = !enabled;
  }, [visible, hasHeadphones]);

  useEffect(() => {
    typedPreviewAudioUriRef.current = null;
    typedPreviewMessageRef.current = null;
    setTypedMessageReady(false);
  }, [typedMessage]);

  const commitTypedMessage = useCallback(() => {
    if (!typedMessage.trim()) return;
    logComposeDiag('typed:commit', { length: typedMessage.trim().length });
    setTypedMessageReady(true);
    Keyboard.dismiss();
  }, [typedMessage]);

  useEffect(() => {
    if (!visible || reactionMode !== 'typed') {
      setIsTypedKeyboardVisible(false);
      return;
    }
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, () => {
      setIsTypedKeyboardVisible(true);
      logComposeDiag('typed:keyboard-show', { platform: Platform.OS });
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setIsTypedKeyboardVisible(false);
      logComposeDiag('typed:keyboard-hide', { platform: Platform.OS });
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [reactionMode, typedMessage, visible]);

  useEffect(() => {
    if (!visible || !currentExplorerId || !user?.uid) {
      setResolvedCompanionAvatarUrl(null);
      return;
    }
    const match = companions.find((c) => c.userId === user.uid);
    if (match?.avatarUrl) {
      setResolvedCompanionAvatarUrl(match.avatarUrl);
      return;
    }
    const s3Key = activeRelationship?.companionAvatarS3Key;
    if (!s3Key) {
      setResolvedCompanionAvatarUrl(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `${API_ENDPOINTS.GET_S3_URL}?explorer_id=${currentExplorerId}&event_id=${user.uid}&filename=avatar.jpg&path=avatars&method=GET`,
        );
        if (!res.ok || cancelled) return;
        const { url } = await res.json();
        if (!cancelled) setResolvedCompanionAvatarUrl(url ?? null);
      } catch {
        if (!cancelled) setResolvedCompanionAvatarUrl(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeRelationship?.companionAvatarS3Key, companions, currentExplorerId, user?.uid, visible]);

  useEffect(() => {
    isPreviewPlayingRef.current = isPreviewPlaying;
  }, [isPreviewPlaying]);

  useEffect(() => {
    if (durationMillis <= MIN_TRIM_GAP_MS) return;
    setTrimEndMs((prev) => {
      const next = prev <= MIN_TRIM_GAP_MS ? durationMillis : Math.min(prev, durationMillis);
      trimEndMsRef.current = next;
      return next;
    });
  }, [durationMillis]);

  useEffect(() => {
    canScrubRef.current =
      reactionMode === 'selfie' && isVideoParent && !isRecording && recordedUri == null;
  }, [isRecording, isVideoParent, reactionMode, recordedUri]);

  useEffect(() => {
    if (!visible) return;
    void (async () => {
      try {
        if (Platform.OS === 'ios') {
          await configureConnectReactionRecordingAudioSessionAsync();
        }
      } catch (error) {
        console.warn('[ReactionSheet] initial audio session failed:', error);
      }
      let current = await Camera.getCameraPermissionsAsync();
      if (!current.granted && current.canAskAgain) {
        current = await Camera.requestCameraPermissionsAsync();
      }
      let cameraMic = await Camera.getMicrophonePermissionsAsync();
      if (!cameraMic.granted && cameraMic.canAskAgain) {
        cameraMic = await Camera.requestMicrophonePermissionsAsync();
      }
      const micGranted = await ensureMicPermissionAsync();
      void requestCameraPermission();
      setNativeCameraGranted(current.granted);
      setMicReady(micGranted && cameraMic.granted);
    })();
  }, [visible, requestCameraPermission]);

  useEffect(() => {
    if (!visible || !isVideoParent || reactionMode !== 'selfie') return;
    void configureConnectReactionRecordingAudioSessionAsync().catch((error) => {
      console.warn('[ReactionSheet] video selfie audio pre-warm failed:', error);
    });
  }, [visible, isVideoParent, reactionMode]);

  useEffect(() => {
    cameraInstanceKeyRef.current = cameraInstanceKey;
  }, [cameraInstanceKey]);

  useEffect(() => {
    if (!REACTION_COMPOSE_DIAG) return;
    logComposeDiag(visible ? 'sheet:open' : 'sheet:close', {
      parentType: isVideoParent ? 'video' : isImageParent ? 'image' : 'unknown',
    });
  }, [visible, isVideoParent, isImageParent]);

  const ensureCameraPermission = useCallback(async () => {
    let current = await Camera.getCameraPermissionsAsync();
    if (!current.granted && current.canAskAgain) {
      current = await Camera.requestCameraPermissionsAsync();
    }
    void requestCameraPermission();
    setNativeCameraGranted(current.granted);
    return current.granted;
  }, [requestCameraPermission]);

  const handleGrantCameraAccess = useCallback(async () => {
    const current = await Camera.getCameraPermissionsAsync();
    if (current.granted) {
      setNativeCameraGranted(true);
      void requestCameraPermission();
      return;
    }

    if (current.canAskAgain) {
      const requested = await Camera.requestCameraPermissionsAsync();
      void requestCameraPermission();
      setNativeCameraGranted(requested.granted);
      return;
    }

    Alert.alert(
      'Camera Access Needed',
      'To record a selfie reaction, allow camera access in Settings.',
      [
        { text: 'Open Settings', onPress: () => void Linking.openSettings() },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  }, [requestCameraPermission]);

  const applySelfieAppBackgroundSideEffects = useCallback(() => {
    if (isRecordingRef.current) {
      stopSelfieRecordingRef.current?.();
      return;
    }
    if (selfieCaptureArmingRef.current) {
      selfieCaptureArmingRef.current = false;
      setIsSelfieCaptureArming(false);
      setIsCameraRestoring(false);
      recordingSessionIdRef.current += 1;
    }
  }, []);

  useEffect(() => {
    if (!visible || reactionMode !== 'selfie') return;

    const clearAppStateBackgroundDebounce = () => {
      if (appStateBackgroundDebounceRef.current) {
        clearTimeout(appStateBackgroundDebounceRef.current);
        appStateBackgroundDebounceRef.current = null;
      }
    };

    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        if (appStateBackgroundDebounceRef.current) {
          clearAppStateBackgroundDebounce();
        }
        setIsAppForeground(true);
        void ensureCameraPermission();
        return;
      }

      if (Platform.OS === 'android') {
        if (appStateBackgroundDebounceRef.current) return;
        appStateBackgroundDebounceRef.current = setTimeout(() => {
          appStateBackgroundDebounceRef.current = null;
          logComposeDiag('selfie:app-background-confirmed', { nextState });
          setIsAppForeground(false);
          applySelfieAppBackgroundSideEffects();
        }, ANDROID_SELFIE_APPSTATE_BACKGROUND_MS);
        return;
      }

      setIsAppForeground(false);
      applySelfieAppBackgroundSideEffects();
    });

    return () => {
      subscription.remove();
      clearAppStateBackgroundDebounce();
    };
  }, [visible, reactionMode, ensureCameraPermission, applySelfieAppBackgroundSideEffects]);

  useEffect(() => {
    if (visible) {
      setIsAppForeground(true);
      return;
    }
    if (appStateBackgroundDebounceRef.current) {
      clearTimeout(appStateBackgroundDebounceRef.current);
      appStateBackgroundDebounceRef.current = null;
    }
    setIsAppForeground(true);
  }, [visible]);

  useEffect(() => {
    cameraReadyRef.current = cameraReady;
  }, [cameraReady]);

  // The persistent CameraView keeps its readiness across an `active` suspend
  // (preview) / resume (retake) cycle. We deliberately do NOT clear cameraReady
  // when the preview opens — that would make retake depend on onCameraReady
  // re-firing on resume, which is exactly the fragility that broke retake. We
  // only clear readiness when the view actually unmounts (sheet closed, left
  // selfie mode, or app backgrounded). The recordAsync retry loop absorbs the
  // brief window while the suspended session spins back up.
  useEffect(() => {
    const selfieSessionOpen = visible && reactionMode === 'selfie';
    if (!selfieSessionOpen) {
      setCameraReady(false);
      setIsCameraRestoring(false);
      return;
    }
    if (!isAppForeground) {
      setCameraReady(false);
      setIsCameraRestoring(false);
    }
  }, [visible, reactionMode, isAppForeground]);

  // Safety net for expo-camera's flaky onCameraReady: once the persistent,
  // active CameraView has been up for the warm-up window without reporting
  // ready, assume it is ready so recording is never permanently blocked.
  // (isSelfieRecordCameraActive is computed later in render, so inline it here.)
  const cameraSessionRunning =
    visible &&
    reactionMode === 'selfie' &&
    isAppForeground &&
    !companionPreviewOpen &&
    (cameraPermission?.granted === true || nativeCameraGranted === true);
  useEffect(() => {
    if (!cameraSessionRunning || cameraReady) return;
    const timer = setTimeout(() => {
      if (cameraReadyRef.current) return;
      logComposeDiag('selfie:camera-ready-fallback', {
        cameraKey: cameraInstanceKeyRef.current,
      });
      setCameraReady(true);
      setIsCameraRestoring(false);
    }, SELFIE_CAMERA_READY_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [cameraSessionRunning, cameraReady]);

  useEffect(() => {
    if (visible) return;
    layoutUiPhaseRef.current = null;
    setIsRecording(false);
    setPositionMillis(0);
    setDurationMillis(0);
    setRecordedUri(null);
    setIsSelfieSaving(false);
    setSelfieCaptureFinalizePending(false);
    setIsSelfieCaptureArming(false);
    setIsSelfieRetakePreparing(false);
    selfieCaptureArmingRef.current = false;
    cameraRecordingStartedRef.current = false;
    setRecordedAudioSnapshot(null);
    setSyncStartTimeMillis(null);
    setSyncEndTimeMillis(null);
    setIsPreviewPlaying(false);
    companionPreviewOpenRef.current = false;
    setCompanionPreviewOpen(false);
    companionPreviewPlayingRef.current = false;
    setCompanionPreviewPlaying(false);
    setShowCompanionPreviewReplay(false);
    companionPreviewStopPendingRef.current = false;
    companionPreviewAutoStartDoneRef.current = false;
    selfiePreviewExpectPlayingRef.current = false;
    if (selfiePreviewResumeTimerRef.current) {
      clearTimeout(selfiePreviewResumeTimerRef.current);
      selfiePreviewResumeTimerRef.current = null;
    }
    if (retakeReleaseTimerRef.current) {
      clearTimeout(retakeReleaseTimerRef.current);
      retakeReleaseTimerRef.current = null;
    }
    setTrimStartMs(0);
    setTrimEndMs(0);
    trimStartMsRef.current = 0;
    trimEndMsRef.current = 0;
    setIsParentReflectionMuted(true);
    isParentReflectionMutedRef.current = true;
    userToggledMuteRef.current = false;
    setReactionMode('selfie');
    setTypedMessage('');
    setTypedMessageReady(false);
    setVoiceRecordedUri(null);
    setIsVoiceRecording(false);
    setIsStartingVoiceRecording(false);
    setIsVoiceProcessing(false);
    setNativeCameraGranted(null);
    isVideoDragActiveRef.current = false;
    previewStopPendingRef.current = false;
    pendingSeekTargetRef.current = null;
    seekChainRef.current = Promise.resolve();
    setCameraReady(false);
    setIsCameraRestoring(false);
    setIsUploading(false);
    if (recordSaveTimeoutRef.current) {
      clearTimeout(recordSaveTimeoutRef.current);
      recordSaveTimeoutRef.current = null;
    }
    recordingPromiseRef.current = null;
    recordingAudioReassertCancelRef.current?.();
    recordingAudioReassertCancelRef.current = null;
    isRecordingRef.current = false;
    isStartingVoiceRecordingRef.current = false;
    void (async () => {
      try {
        if (voiceExpoAvRecordingRef.current) {
          await voiceExpoAvRecordingRef.current.stopAndUnloadAsync();
        }
      } catch {
        /* ignore */
      }
      voiceExpoAvRecordingRef.current = null;
      await unloadPreviewAudio();
    })();
    typedPreviewAudioUriRef.current = null;
    typedPreviewMessageRef.current = null;
    void videoRef.current?.pauseAsync().catch(() => {});
    void videoRef.current?.setVolumeAsync(1).catch(() => {});
    cameraRef.current?.stopRecording();
  }, [visible]);

  useEffect(() => {
    if (!isVideoParent || recordedUri != null) return;
    if (isPreviewPlayingRef.current && !isRecordingRef.current) return;
    void applyParentReflectionVolume();
  }, [
    applyParentReflectionVolume,
    hasHeadphones,
    isParentReflectionMuted,
    isPreviewPlaying,
    isRecording,
    isVideoParent,
    recordedUri,
  ]);

  const clampTrimStart = useCallback((startMs: number) => {
    const end = trimEndMsRef.current || durationMillisRef.current;
    if (end <= MIN_TRIM_GAP_MS) return 0;
    return Math.max(0, Math.min(startMs, end - MIN_TRIM_GAP_MS));
  }, []);

  const setReactionStartMs = useCallback(
    (startMs: number) => {
      const clamped = clampTrimStart(startMs);
      setTrimStartMs(clamped);
      trimStartMsRef.current = clamped;
      positionMillisRef.current = clamped;
      setPositionMillis(clamped);
      return clamped;
    },
    [clampTrimStart],
  );

  const queueVideoSeek = useCallback(
    (targetMs: number, options?: { updateUi?: boolean }) => {
      if (!isVideoParent || isRecording) return seekChainRef.current;

      const end = trimEndMsRef.current || durationMillisRef.current;
      const target = Math.max(0, Math.min(targetMs, end));

      if (options?.updateUi !== false) {
        positionMillisRef.current = target;
        setPositionMillis(target);
      }

      pendingSeekTargetRef.current = target;

      seekChainRef.current = seekChainRef.current
        .then(async () => {
          while (pendingSeekTargetRef.current != null) {
            const nextTarget = pendingSeekTargetRef.current;
            pendingSeekTargetRef.current = null;
            await runVideoCommand(
              () => videoRef.current?.setPositionAsync(nextTarget, SEEK_TOLERANCE),
              'seek failed',
            );
          }
        })
        .catch(() => {});

      return seekChainRef.current;
    },
    [SEEK_TOLERANCE, isRecording, isVideoParent],
  );

  const commitVideoPosition = useCallback(
    async (
      targetMs: number,
      options?: { shouldPlay?: boolean; volume?: number },
    ) => {
      const end = trimEndMsRef.current || durationMillisRef.current;
      const target = Math.max(0, Math.min(targetMs, end));
      positionMillisRef.current = target;
      setPositionMillis(target);

      if (options?.shouldPlay != null) {
        const muted = isParentMutedForPlayback();
        const volume = options.volume ?? getReactionParentVolume();
        await runVideoCommand(
          () =>
            videoRef.current?.setStatusAsync({
              positionMillis: target,
              shouldPlay: options.shouldPlay,
              isMuted: muted,
              volume,
            }),
          'commit seek failed',
        );
        return;
      }

      void queueVideoSeek(target, { updateUi: false });
    },
    [getReactionParentVolume, isParentMutedForPlayback, queueVideoSeek],
  );

  const stopPreviewAtTrimEnd = useCallback(async () => {
    if (!isVideoParent || previewStopPendingRef.current || !isPreviewPlayingRef.current) return;
    previewStopPendingRef.current = true;
    setIsPreviewPlaying(false);
    isPreviewPlayingRef.current = false;
    const start = trimStartMsRef.current;
    positionMillisRef.current = start;
    setPositionMillis(start);
    try {
      await runVideoCommand(() => videoRef.current?.pauseAsync(), 'preview pause failed');
      await runVideoCommand(
        () =>
          videoRef.current?.setStatusAsync({
            positionMillis: start,
            shouldPlay: false,
            isMuted: false,
            volume: resolveReactionRecordingVolume({
              muted: false,
              hasHeadphones: hasHeadphonesRef.current,
            }),
          }),
        'preview stop failed',
      );
    } finally {
      previewStopPendingRef.current = false;
    }
  }, [getReactionParentVolume, isVideoParent]);

  const handlePlaybackStatusUpdate = useCallback(
    (status: AVPlaybackStatus) => {
      if (!status.isLoaded) return;

      const duration = status.durationMillis ?? 0;
      if (duration > 0) {
        setDurationMillis(duration);
        durationMillisRef.current = duration;
      }

      if (recordedUri && isVideoParent) {
        return;
      }

      const recordingActive = isRecordingRef.current && isVideoParent;
      const previewActive =
        isPreviewPlayingRef.current &&
        isVideoParent &&
        !recordingActive &&
        !recordedUri;

      // Idle/recording volume only — preview audio is set imperatively in toggleParentPlayback.
      if (isVideoParent && !recordingActive && !previewActive) {
        const now = Date.now();
        if (now - lastParentVolumeApplyRef.current >= 200) {
          lastParentVolumeApplyRef.current = now;
          void applyParentReflectionVolume();
        }
      }

      if (recordingActive) {
        if (!isScrubbingRef.current) {
          positionMillisRef.current = status.positionMillis;
          setPositionMillis(status.positionMillis);
        }
        return;
      }

      if (!isVideoParent) return;

      // Track playhead during intentional preview even while Android buffers (isPlaying may lag).
      if (previewActive && !isScrubbingRef.current) {
        positionMillisRef.current = status.positionMillis;
        setPositionMillis(status.positionMillis);
      }

      if (previewActive && status.isPlaying && !isScrubbingRef.current) {
        const end = trimEndMsRef.current || duration;
        if (
          end > trimStartMsRef.current &&
          status.positionMillis >= end - PREVIEW_END_EPSILON_MS &&
          status.positionMillis > trimStartMsRef.current + PREVIEW_END_EPSILON_MS
        ) {
          void stopPreviewAtTrimEnd();
        }
      }

      // Do not infer "paused" from transient !isPlaying while previewActive — that race was
      // clearing preview state before playback started and freezing the scrubber on Android.
    },
    [
      applyParentReflectionVolume,
      isVideoParent,
      stopPreviewAtTrimEnd,
      recordedUri,
    ],
  );

  const pauseParentPreview = useCallback(async () => {
    if (!isVideoParent) return;
    setIsPreviewPlaying(false);
    isPreviewPlayingRef.current = false;
    await runVideoCommand(() => videoRef.current?.pauseAsync(), 'pause preview failed');
  }, [isVideoParent]);

  const startParentTrimPreview = useCallback(async () => {
    if (!isVideoParent || isRecordingRef.current || recordedUri) return false;

    const status = await videoRef.current?.getStatusAsync().catch(() => null);
    if (!status?.isLoaded) return false;

    const start = trimStartMsRef.current;
    positionMillisRef.current = start;
    setPositionMillis(start);
    const previewVolume = getParentPreviewPlaybackVolume();

    isPreviewPlayingRef.current = true;
    setIsPreviewPlaying(true);

    try {
      // iOS keeps the reaction recording session while the selfie camera is live — switching to
      // pure playback mode here prevents parent preview from starting. Android uses playback mode.
      if (Platform.OS === 'ios') {
        await configureConnectReactionRecordingAudioSessionAsync();
        await videoRef.current?.setStatusAsync({
          positionMillis: start,
          shouldPlay: true,
          isMuted: false,
          volume: previewVolume,
        });
      } else {
        await configureConnectPlaybackAudioSessionAsync({ retries: 2 });
        const started = await runConnectAvCommandWithRetry(
          async () => {
            await videoRef.current?.setStatusAsync({
              positionMillis: start,
              shouldPlay: false,
              isMuted: false,
              volume: previewVolume,
            });
            await videoRef.current?.playAsync();
          },
          {
            stableMs: ANDROID_PREVIEW_APPSTATE_STABLE_MS,
            stableTimeoutMs: ANDROID_PREVIEW_APPSTATE_WAIT_TIMEOUT_MS,
          },
        );
        if (!started) {
          throw new Error('Trim preview could not start');
        }
      }
    } catch (error) {
      if (!isSeekInterrupted(error)) {
        console.warn('[ReactionSheet] start trim preview failed:', error);
      }
      isPreviewPlayingRef.current = false;
      setIsPreviewPlaying(false);
      return false;
    }

    return true;
  }, [getParentPreviewPlaybackVolume, isVideoParent, recordedUri]);

  const toggleParentPlayback = useCallback(async () => {
    if (!isVideoParent || isRecording || recordedUri) return;
    if (parentPreviewToggleBusyRef.current) return;
    parentPreviewToggleBusyRef.current = true;

    try {
      if (isPreviewPlayingRef.current) {
        await pauseParentPreview();
        const start = trimStartMsRef.current;
        await commitVideoPosition(start, {
          shouldPlay: false,
          volume: getReactionParentVolume(),
        });
        return;
      }

      await startParentTrimPreview();
    } finally {
      parentPreviewToggleBusyRef.current = false;
    }
  }, [
    commitVideoPosition,
    getReactionParentVolume,
    isRecording,
    isVideoParent,
    pauseParentPreview,
    recordedUri,
    startParentTrimPreview,
  ]);

  // expo-av progress callbacks can stall while the player buffers; poll during preview so the
  // trim scrubber tracks like ReflectionComposer's expo-video timeUpdate listener.
  useEffect(() => {
    if (!isPreviewPlaying || !isVideoParent || isRecording || recordedUri) return;

    let cancelled = false;
    const pollPlayhead = async () => {
      if (cancelled || isScrubbingRef.current || !isPreviewPlayingRef.current) return;
      const status = await videoRef.current?.getStatusAsync().catch(() => null);
      if (!status?.isLoaded || cancelled || isScrubbingRef.current) return;
      positionMillisRef.current = status.positionMillis;
      setPositionMillis(status.positionMillis);

      const duration = status.durationMillis ?? durationMillisRef.current;
      const end = trimEndMsRef.current || duration;
      if (
        status.isPlaying &&
        end > trimStartMsRef.current &&
        status.positionMillis >= end - PREVIEW_END_EPSILON_MS &&
        status.positionMillis > trimStartMsRef.current + PREVIEW_END_EPSILON_MS
      ) {
        void stopPreviewAtTrimEnd();
      }
    };

    void pollPlayhead();
    const interval = setInterval(() => {
      void pollPlayhead();
    }, 250);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isPreviewPlaying, isRecording, isVideoParent, recordedUri, stopPreviewAtTrimEnd]);

  const toggleParentReflectionMute = useCallback(() => {
    userToggledMuteRef.current = true;
    setIsParentReflectionMuted((prev) => {
      const next = !prev;
      isParentReflectionMutedRef.current = next;
      return next;
    });
  }, []);

  const handleTrimChange = useCallback(
    (start: number, end: number) => {
      setTrimStartMs(start);
      setTrimEndMs(end);
      trimStartMsRef.current = start;
      trimEndMsRef.current = end;
      if (!isPreviewPlaying) {
        positionMillisRef.current = start;
        setPositionMillis(start);
      }
    },
    [isPreviewPlaying],
  );

  const handleSeek = useCallback(
    (nextPositionMillis: number) => {
      positionMillisRef.current = nextPositionMillis;
      setPositionMillis(nextPositionMillis);
      const now = Date.now();
      if (now - lastPanSeekAtRef.current >= 120) {
        lastPanSeekAtRef.current = now;
        void queueVideoSeek(nextPositionMillis, { updateUi: false });
      }
    },
    [queueVideoSeek],
  );

  const handleScrubStart = useCallback(() => {
    isScrubbingRef.current = true;
    void pauseParentPreview();
  }, [pauseParentPreview]);

  const handleScrubEnd = useCallback(() => {
    void (async () => {
      await commitVideoPosition(trimStartMsRef.current, {
        shouldPlay: false,
        volume: getReactionParentVolume(),
      });
      isScrubbingRef.current = false;
    })().catch(() => {});
  }, [commitVideoPosition, getReactionParentVolume]);

  const beginVideoDragScrub = useCallback(() => {
    if (isVideoDragActiveRef.current) return;
    isVideoDragActiveRef.current = true;
    isScrubbingRef.current = true;
    seekOriginMsRef.current = trimStartMsRef.current;
    void pauseParentPreview();
  }, [pauseParentPreview]);

  const handleSeekDragStart = useCallback(() => {
    beginVideoDragScrub();
  }, [beginVideoDragScrub]);

  const handleSeekDrag = useCallback(
    (translationX: number) => {
      if (!canScrubRef.current) return;
      beginVideoDragScrub();

      const width = parentVideoWidthRef.current;
      const duration = durationMillisRef.current;
      if (width <= 0 || duration <= 0) return;

      const deltaMs = (translationX / width) * duration;
      const start = setReactionStartMs(seekOriginMsRef.current + deltaMs);
      const now = Date.now();
      if (now - lastPanSeekAtRef.current >= 120) {
        lastPanSeekAtRef.current = now;
        void queueVideoSeek(start, { updateUi: false });
      }
    },
    [beginVideoDragScrub, queueVideoSeek, setReactionStartMs],
  );

  const handleSeekDragEnd = useCallback(() => {
    void (async () => {
      const start = trimStartMsRef.current;
      await commitVideoPosition(start, {
        shouldPlay: false,
        volume: getReactionParentVolume(),
      });
      isVideoDragActiveRef.current = false;
      isScrubbingRef.current = false;
    })().catch(() => {});
  }, [commitVideoPosition, getReactionParentVolume]);

  const showScrubUi =
    reactionMode === 'selfie' && isVideoParent && recordedUri == null;

  const videoPanGesture = useMemo(() => {
    return Gesture.Pan()
      .activeOffsetX([-8, 8])
      .failOffsetY([-12, 12])
      .onBegin(() => {
        runOnJS(handleSeekDragStart)();
      })
      .onUpdate((event) => {
        runOnJS(handleSeekDrag)(event.translationX);
      })
      .onFinalize(() => {
        runOnJS(handleSeekDragEnd)();
      });
  }, [handleSeekDrag, handleSeekDragEnd, handleSeekDragStart]);

  const restoreAfterSelfieCaptureAsync = useCallback(async () => {
    try {
      await releaseConnectCaptureAudioAsync();
      if (isVideoParent) {
        const postRestoreStatus = await videoRef.current?.getStatusAsync().catch(() => null);
        if (postRestoreStatus?.isLoaded) {
          await syncParentVideoAudioAsync(videoRef.current);
        }
      }
    } catch (error) {
      console.warn('[ReactionSheet] failed to restore playback audio session:', error);
    }
  }, [isVideoParent, syncParentVideoAudioAsync]);

  const clearRecordSaveTimeout = useCallback(() => {
    if (recordSaveTimeoutRef.current) {
      clearTimeout(recordSaveTimeoutRef.current);
      recordSaveTimeoutRef.current = null;
    }
  }, []);

  const armRecordSaveTimeout = useCallback(
    (sessionId: number) => {
      clearRecordSaveTimeout();
      const recordingPromise = recordingPromiseRef.current;
      if (!recordingPromise) return;
      recordSaveTimeoutRef.current = setTimeout(() => {
        if (recordingPromiseRef.current !== recordingPromise) return;
        recordingPromiseRef.current = null;
        cameraRecordingStartedRef.current = false;
        setSelfieCaptureFinalizePending(false);
        setIsSelfieSaving(false);
        logComposeDiag('selfie:record-save-timeout', { sessionId }, 'error');
        void restoreAfterSelfieCaptureAsync();
        Alert.alert(
          'Save Timed Out',
          'Could not finish saving your selfie reaction. Please try again.',
        );
      }, SELFIE_RECORD_SAVE_TIMEOUT_MS);
    },
    [clearRecordSaveTimeout, restoreAfterSelfieCaptureAsync],
  );

  const beginCameraRecording = useCallback((sessionId: number): Promise<boolean> => {
    const attachPromise = (recordingPromise: Promise<{ uri: string } | undefined>) => {
      recordingPromiseRef.current = recordingPromise;
      const finalizeSave = async () => {
        clearRecordSaveTimeout();
        setSelfieCaptureFinalizePending(false);
        setIsSelfieSaving(false);
        await restoreAfterSelfieCaptureAsync();
      };
      void recordingPromise
        .then(async (result) => {
          if (recordingPromiseRef.current !== recordingPromise) return;
          recordingPromiseRef.current = null;
          await finalizeSave();
          if (result?.uri) {
            logComposeDiag('selfie:record-saved', { sessionId, hasUri: true });
            setRecordedUri(result.uri);
            setRecordedAudioSnapshot({
              originalAudioMuted: isParentReflectionMutedRef.current,
              hasHeadphones: hasHeadphonesRef.current,
            });
            kickCompanionPreviewStartRef.current('record-complete');
          } else {
            logComposeDiag('selfie:record-too-short', { sessionId }, 'warn');
            Alert.alert(
              'Recording Too Short',
              'Hold the button a little longer so we can capture your reaction.',
            );
          }
        })
        .catch(async (error) => {
          if (recordingPromiseRef.current !== recordingPromise) return;
          recordingPromiseRef.current = null;
          cameraRecordingStartedRef.current = false;
          isRecordingRef.current = false;
          setIsRecording(false);
          await finalizeSave();
          logComposeDiag(
            'selfie:record-failed',
            { sessionId, message: error instanceof Error ? error.message : 'unknown' },
            'error',
          );
          console.warn('[ReactionSheet] recordAsync failed:', error);
          Alert.alert(
            'Recording Failed',
            'Could not save your selfie reaction. Please try again.',
          );
        });
    };

    type TryStartResult = 'started' | 'retry' | 'cancelled';
    const tryStart = (attempt = 0): TryStartResult => {
      if (recordingSessionIdRef.current !== sessionId || !isRecordingRef.current) {
        logComposeDiag('selfie:record-cancelled', { sessionId, attempt });
        return 'cancelled';
      }
      if (!cameraReadyRef.current) {
        return 'retry';
      }
      let recordingPromise: Promise<{ uri: string } | undefined> | undefined;
      try {
        recordingPromise = cameraRef.current?.recordAsync({ maxDuration: 120 });
      } catch (error) {
        logComposeDiag(
          'selfie:record-async-threw',
          {
            sessionId,
            attempt,
            message: error instanceof Error ? error.message : 'unknown',
          },
          'error',
        );
        console.warn('[ReactionSheet] recordAsync threw:', error);
        return 'retry';
      }
      if (!recordingPromise) {
        if (attempt === 0) {
          logComposeDiag('selfie:record-waiting-for-camera', {
            sessionId,
            cameraKey: cameraInstanceKeyRef.current,
          });
        }
        return 'retry';
      }
      attachPromise(recordingPromise);
      cameraRecordingStartedRef.current = true;
      logComposeDiag('selfie:record-async-started', {
        sessionId,
        attempt,
        cameraKey: cameraInstanceKeyRef.current,
      });
      return 'started';
    };

    return new Promise((resolve) => {
      void (async () => {
        const readyDeadline = Date.now() + SELFIE_CAMERA_READY_TIMEOUT_MS;
        while (Date.now() < readyDeadline) {
          if (recordingSessionIdRef.current !== sessionId || !isRecordingRef.current) {
            logComposeDiag('selfie:record-cancelled', { sessionId, reason: 'before-camera-ready' });
            resolve(false);
            return;
          }
          if (cameraReadyRef.current && cameraRef.current) break;
          await new Promise((r) => setTimeout(r, 40));
        }

        if (!cameraReadyRef.current || !cameraRef.current) {
          if (recordingSessionIdRef.current !== sessionId || !isRecordingRef.current) {
            resolve(false);
            return;
          }
          isRecordingRef.current = false;
          setIsRecording(false);
          setIsCameraRestoring(false);
          recordingSessionIdRef.current += 1;
          logComposeDiag('selfie:record-camera-timeout', { sessionId }, 'error');
          void restoreAfterSelfieCaptureAsync();
          Alert.alert(
            'Camera Not Ready',
            'Wait for the camera preview to appear, then hold the button again.',
          );
          resolve(false);
          return;
        }

        logComposeDiag('selfie:camera-ready-for-record', {
          sessionId,
          cameraKey: cameraInstanceKeyRef.current,
        });

        await new Promise((resolve) => setTimeout(resolve, SELFIE_VIDEO_MODE_SETTLE_MS));
        if (recordingSessionIdRef.current !== sessionId || !isRecordingRef.current) {
          resolve(false);
          return;
        }
        logComposeDiag('selfie:video-mode-settled', {
          sessionId,
          settleMs: SELFIE_VIDEO_MODE_SETTLE_MS,
        });

        const first = tryStart(0);
        if (first === 'started') {
          resolve(true);
          return;
        }
        if (first === 'cancelled') {
          resolve(false);
          return;
        }

        for (let attempt = 1; attempt <= 10; attempt++) {
          await new Promise((r) => setTimeout(r, SELFIE_CAMERA_BIND_MS / 2 + attempt * 80));
          const result = tryStart(attempt);
          if (result === 'started') {
            resolve(true);
            return;
          }
          if (result === 'cancelled') {
            resolve(false);
            return;
          }
          logComposeDiag('selfie:record-retry', { sessionId, attempt }, 'warn');
        }
        if (recordingSessionIdRef.current !== sessionId || !isRecordingRef.current) {
          resolve(false);
          return;
        }
        isRecordingRef.current = false;
        setIsRecording(false);
        console.warn('[ReactionSheet] recordAsync never started — camera ref missing?');
        cameraRecordingStartedRef.current = false;
        setIsCameraRestoring(false);
        logComposeDiag('selfie:record-never-started', { sessionId, cameraKey: cameraInstanceKeyRef.current }, 'error');
        void restoreAfterSelfieCaptureAsync();
        Alert.alert(
          'Camera Not Ready',
          'Wait for the camera preview to appear, then hold the button again.',
        );
        resolve(false);
      })();
    });
  }, [clearRecordSaveTimeout, restoreAfterSelfieCaptureAsync]);

  const scheduleRecordingParentReasserts = useCallback(
    (sessionId: number, syncStart: number) => {
      const reassertParentPlayback = async () => {
        if (recordingSessionIdRef.current !== sessionId || !isRecordingRef.current) return;
        try {
          // seek:false — keep the playhead where it is; only re-confirm playback.
          await startParentRecordingPlayback(syncStart, { seek: false });
        } catch (error) {
          console.warn('[ReactionSheet] parent playback reassert failed:', error);
        }
      };

      recordingAudioReassertCancelRef.current?.();
      const timers = RECORDING_PARENT_REASSERT_DELAYS_MS.map((delay) =>
        setTimeout(() => {
          void reassertParentPlayback();
        }, delay),
      );
      recordingAudioReassertCancelRef.current = () => {
        for (const timer of timers) {
          clearTimeout(timer);
        }
      };
    },
    [startParentRecordingPlayback],
  );

  const stopSelfieRecording = useCallback(() => {
    if (!isRecordingRef.current) return;

    const sessionId = recordingSessionIdRef.current;
    const shouldFinalize = cameraRecordingStartedRef.current;

    logComposeDiag('selfie:press-out', {
      cameraStarted: shouldFinalize,
      cameraKey: cameraInstanceKeyRef.current,
    });

    recordingSessionIdRef.current += 1;
    isRecordingRef.current = false;
    recordingAudioReassertCancelRef.current?.();
    recordingAudioReassertCancelRef.current = null;
    if (shouldFinalize) {
      setSelfieCaptureFinalizePending(true);
      setIsSelfieSaving(true);
    } else {
      setSelfieCaptureFinalizePending(false);
      setIsSelfieSaving(false);
    }
    setIsRecording(false);

    void (async () => {
      // Pause parent expo-av playback before stopRecording so iOS can finalize the camera file.
      if (isVideoParent) {
        const status = await videoRef.current?.getStatusAsync();
        if (status?.isLoaded) {
          setSyncEndTimeMillis(status.positionMillis);
        }
        await videoRef.current?.pauseAsync().catch(() => {});
      } else {
        setSyncEndTimeMillis(0);
      }

      if (!shouldFinalize) {
        void restoreAfterSelfieCaptureAsync();
        return;
      }

      const minHoldMs = Platform.OS === 'android' && isVideoParent ? 450 : 0;
      const elapsed = Date.now() - recordingStartedAtRef.current;
      if (minHoldMs > 0 && elapsed < minHoldMs) {
        await new Promise((resolve) => setTimeout(resolve, minHoldMs - elapsed));
      }
      if (recordingSessionIdRef.current !== sessionId + 1) {
        setSelfieCaptureFinalizePending(false);
        setIsSelfieSaving(false);
        return;
      }

      try {
        cameraRef.current?.stopRecording();
        armRecordSaveTimeout(sessionId);
        logComposeDiag('selfie:stop-recording', {
          sessionId,
          hasCameraRef: !!cameraRef.current,
        });
      } catch (error) {
        console.warn('[ReactionSheet] stopRecording failed:', error);
      }
    })();
  }, [armRecordSaveTimeout, isVideoParent, restoreAfterSelfieCaptureAsync]);

  useEffect(() => {
    stopSelfieRecordingRef.current = stopSelfieRecording;
  }, [stopSelfieRecording]);

  const handlePressIn = useCallback(() => {
    if (recordedUri || isSelfieRetakePreparing) return;

    const cameraGranted = cameraPermission?.granted || nativeCameraGranted;
    if (!cameraGranted) {
      logComposeDiag('selfie:press-in-denied', { reason: 'camera-permission' }, 'warn');
      void ensureCameraPermission();
      return;
    }

    const syncStart = isVideoParent ? trimStartMsRef.current : 0;
    const sessionId = recordingSessionIdRef.current + 1;
    logComposeDiag('selfie:press-in', {
      sessionId,
      isVideoParent,
      syncStartMs: syncStart,
      trimStartMs: trimStartMsRef.current,
    });
    recordingSessionIdRef.current = sessionId;
    recordingPromiseRef.current = null;
    recordingStartedAtRef.current = Date.now();
    cameraRecordingStartedRef.current = false;
    // Do NOT reset cameraReady here: the persistent CameraView is already warm
    // and won't emit a fresh onCameraReady just because state flips. Only show
    // the warming spinner if the session genuinely hasn't reported ready yet.
    if (!cameraReadyRef.current) {
      setIsCameraRestoring(true);
    }
    setIsSelfieCaptureArming(true);
    selfieCaptureArmingRef.current = true;
    setSyncStartTimeMillis(syncStart);
    setIsPreviewPlaying(false);
    isPreviewPlayingRef.current = false;
    void pauseParentPreview();

    const cancelArming = () => {
      if (recordingSessionIdRef.current !== sessionId) return;
      selfieCaptureArmingRef.current = false;
      setIsSelfieCaptureArming(false);
      setIsCameraRestoring(false);
      recordingSessionIdRef.current += 1;
    };

    void (async () => {
      const micGranted = micReady || (await ensureMicPermissionAsync());
      setMicReady(micGranted);
      if (!micGranted) {
        if (recordingSessionIdRef.current === sessionId && selfieCaptureArmingRef.current) {
          logComposeDiag('selfie:press-in-abort', { sessionId, reason: 'mic-permission' }, 'warn');
          cancelArming();
          await videoRef.current?.pauseAsync().catch(() => {});
          Alert.alert(
            'Microphone Access Needed',
            'Allow microphone access to record a selfie reaction.',
          );
        }
        return;
      }

      try {
        await configureConnectReactionRecordingAudioSessionAsync({ retries: 2 });
      } catch (error) {
        console.warn('[ReactionSheet] reaction recording audio session failed:', error);
      }
      if (recordingSessionIdRef.current !== sessionId || !selfieCaptureArmingRef.current) return;

      selfieCaptureArmingRef.current = false;
      setIsSelfieCaptureArming(false);
      setIsRecording(true);
      isRecordingRef.current = true;
      logComposeDiag('selfie:capture-armed', {
        sessionId,
        cameraKey: cameraInstanceKeyRef.current,
      });

      const cameraStarted = await beginCameraRecording(sessionId);
      if (!cameraStarted || recordingSessionIdRef.current !== sessionId || !isRecordingRef.current) {
        return;
      }

      if (!isVideoParent) return;

      try {
        logComposeDiag('selfie:parent-sync-start', { sessionId, syncStartMs: syncStart });
        await startParentRecordingPlayback(syncStart);
        if (recordingSessionIdRef.current !== sessionId || !isRecordingRef.current) return;
        scheduleRecordingParentReasserts(sessionId, syncStart);
      } catch (error) {
        console.warn('[ReactionSheet] parent playback during selfie failed:', error);
      }
    })();
  }, [
    beginCameraRecording,
    cameraPermission?.granted,
    ensureCameraPermission,
    isSelfieRetakePreparing,
    isVideoParent,
    micReady,
    nativeCameraGranted,
    recordedUri,
    scheduleRecordingParentReasserts,
    startParentRecordingPlayback,
    pauseParentPreview,
  ]);

  const handlePressOut = useCallback(() => {
    if (isRecordingRef.current) {
      stopSelfieRecording();
      return;
    }
    if (selfieCaptureArmingRef.current) {
      selfieCaptureArmingRef.current = false;
      setIsSelfieCaptureArming(false);
      setIsCameraRestoring(false);
      recordingSessionIdRef.current += 1;
    }
  }, [stopSelfieRecording]);

  const resetVoiceRecording = useCallback(() => {
    setVoiceRecordedUri(null);
    setRecordedAudioSnapshot(null);
    setIsVoiceRecording(false);
    setIsStartingVoiceRecording(false);
    setIsVoiceProcessing(false);
    isStartingVoiceRecordingRef.current = false;
    void (async () => {
      try {
        if (voiceExpoAvRecordingRef.current) {
          await voiceExpoAvRecordingRef.current.stopAndUnloadAsync();
        }
      } catch {
        /* ignore */
      }
      voiceExpoAvRecordingRef.current = null;
      try {
        if (voiceRecorder.isRecording) {
          await voiceRecorder.stop();
        }
      } catch {
        /* ignore */
      }
      await unloadPreviewAudio();
    })();
  }, [unloadPreviewAudio, voiceRecorder]);

  const applyReactionModeChange = useCallback(
    (nextMode: ReactionComposeMode) => {
      setReactionMode(nextMode);
      setRecordedUri(null);
      setSyncStartTimeMillis(null);
      setSyncEndTimeMillis(null);
      setIsPreviewPlaying(false);
      setIsRecording(false);
      resetVoiceRecording();
      setTypedMessage('');
      setTypedMessageReady(false);
      logComposeDiag(`mode:${nextMode}`, { from: reactionMode, platform: Platform.OS });
      if (nextMode === 'selfie') {
        void ensureCameraPermission();
        void configureConnectReactionRecordingAudioSessionAsync().catch((error) => {
          console.warn('[ReactionSheet] selfie mode recording session failed:', error);
        });
      }
      if (nextMode === 'voice') {
        void (async () => {
          logComposeDiag('voice:mode-enter', { from: reactionMode });
          const micGranted = await ensureMicPermissionAsync();
          setMicReady(micGranted);
          logComposeDiag('voice:mic-permission', { granted: micGranted });
          if (!micGranted) {
            Alert.alert(
              'Microphone Access Needed',
              'Allow microphone access to record a voice reaction.',
            );
            return;
          }
        })();
      }
      void videoRef.current?.pauseAsync().catch(() => {});
    },
    [
      ensureCameraPermission,
      reactionMode,
      resetVoiceRecording,
    ],
  );

  const handleReactionModeChange = useCallback(
    (nextMode: ReactionComposeMode) => {
      if (nextMode === reactionMode || isUploading) return;

      if (reactionMode === 'typed' && isTypedKeyboardVisible) {
        // Switching away from typed while the keyboard is up: the window/KAV resize is
        // still in flight, and re-laying-out the stage mid-resize is what scrunches the
        // selfie stage to the top. Dismiss first, then apply the switch once settled.
        Keyboard.dismiss();
        let settled = false;
        const proceed = () => {
          if (settled) return;
          settled = true;
          subscription.remove();
          logComposeDiag('mode:keyboard-settled', { nextMode, platform: Platform.OS });
          applyReactionModeChange(nextMode);
        };
        const subscription = Keyboard.addListener('keyboardDidHide', proceed);
        setTimeout(proceed, 350);
        return;
      }

      if (reactionMode === 'typed') {
        Keyboard.dismiss();
      }
      applyReactionModeChange(nextMode);
    },
    [applyReactionModeChange, isTypedKeyboardVisible, isUploading, reactionMode],
  );

  const handleStartVoiceRecording = useCallback(async () => {
    if (isVoiceRecording || isStartingVoiceRecording || isStartingVoiceRecordingRef.current) {
      return;
    }
    if (Platform.OS !== 'android' && voiceRecorder.isRecording) {
      return;
    }
    isStartingVoiceRecordingRef.current = true;
    setIsStartingVoiceRecording(true);
    logComposeDiag('voice:start-tap', { micReady, isVideoParent, isImageParent });
    try {
      let micGranted = micReady;
      if (!micGranted) {
        micGranted = await ensureMicPermissionAsync();
      }
      setMicReady(micGranted);
      if (!micGranted) {
        Alert.alert(
          'Microphone Access Needed',
          'Allow microphone access to record a voice reaction.',
        );
        return;
      }

      void unloadPreviewAudio();

      if (Platform.OS === 'android') {
        const recording = await startAndroidExpoAvVoiceRecordingAsync({
          isVideoParent,
          trimStartMs: trimStartMsRef.current,
          startParentPlayback: isVideoParent ? startParentRecordingPlayback : undefined,
        });
        voiceExpoAvRecordingRef.current = recording;
        setIsVoiceRecording(true);
        logComposeDiag('voice:recording-started', { platform: 'android' });
        return;
      }

      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });
      if (isVideoParent) {
        await configureConnectReactionRecordingAudioSessionAsync();
        const startMs = trimStartMsRef.current;
        await startParentRecordingPlayback(startMs);
        await startExpoAudioVoiceRecordingAsync(voiceRecorder, { skipSessionConfigure: true });
      } else {
        await startExpoAudioVoiceRecordingAsync(voiceRecorder);
      }
      setIsVoiceRecording(true);
      logComposeDiag('voice:recording-started', { platform: Platform.OS });
    } catch (error) {
      console.warn('[ReactionSheet] voice record start failed:', error);
      logComposeDiag('voice:start-failed', {
        message: error instanceof Error ? error.message : String(error),
      }, 'error');
      voiceExpoAvRecordingRef.current = null;
      setIsVoiceRecording(false);
      Alert.alert(
        'Recording Failed',
        error instanceof Error ? error.message : 'Could not start voice recording.',
      );
    } finally {
      isStartingVoiceRecordingRef.current = false;
      setIsStartingVoiceRecording(false);
    }
  }, [
    isStartingVoiceRecording,
    isVideoParent,
    isVoiceRecording,
    micReady,
    startParentRecordingPlayback,
    unloadPreviewAudio,
    voiceRecorder,
  ]);
  const handleStopVoiceRecording = useCallback(async () => {
    if (!isVoiceRecording || isVoiceProcessing) return;
    setIsVoiceProcessing(true);
    logComposeDiag('voice:stop-tap');
    try {
      if (isVideoParent) {
        await runVideoCommand(() => videoRef.current?.pauseAsync(), 'voice reaction pause failed');
      }

      let recordingUri: string | null = null;
      if (Platform.OS === 'android' && voiceExpoAvRecordingRef.current) {
        const recording = voiceExpoAvRecordingRef.current;
        voiceExpoAvRecordingRef.current = null;
        await recording.stopAndUnloadAsync();
        recordingUri = recording.getURI();
      } else {
        await voiceRecorder.stop();
        recordingUri = voiceRecorder.uri ?? voiceRecorder.getStatus().url ?? null;
      }

      setIsVoiceRecording(false);
      if (recordingUri) {
        logComposeDiag('voice:record-saved', { hasUri: true });
        setVoiceRecordedUri(recordingUri);
        setRecordedAudioSnapshot({
          originalAudioMuted: isParentReflectionMutedRef.current,
          hasHeadphones: hasHeadphonesRef.current,
        });
        void configureConnectPlaybackAudioSessionAsync({ retries: 2 }).catch((error) => {
          console.warn('[ReactionSheet] voice playback session reset failed:', error);
        });
      }
    } catch (error) {
      console.warn('[ReactionSheet] voice record stop failed:', error);
      setIsVoiceRecording(false);
      voiceExpoAvRecordingRef.current = null;
    } finally {
      setIsVoiceProcessing(false);
      logComposeDiag('voice:stop-done');
    }
  }, [isVideoParent, isVoiceProcessing, isVoiceRecording, voiceRecorder]);

  const handleRetake = useCallback(() => {
    selfiePreviewExpectPlayingRef.current = false;
    companionPreviewAutoStartDoneRef.current = false;
    setCompanionPreviewSendHint(false);
    if (selfiePreviewResumeTimerRef.current) {
      clearTimeout(selfiePreviewResumeTimerRef.current);
      selfiePreviewResumeTimerRef.current = null;
    }
    if (retakeReleaseTimerRef.current) {
      clearTimeout(retakeReleaseTimerRef.current);
      retakeReleaseTimerRef.current = null;
    }
    if (reactionMode === 'voice') {
      setCompanionPreviewOpen(false);
      setCompanionPreviewPlaying(false);
      setShowCompanionPreviewReplay(false);
      setIsVoiceProcessing(true);
      void (async () => {
        try {
          setVoiceRecordedUri(null);
          setRecordedAudioSnapshot(null);
          setIsVoiceRecording(false);
          isStartingVoiceRecordingRef.current = false;
          setIsStartingVoiceRecording(false);
          try {
            if (voiceExpoAvRecordingRef.current) {
              await voiceExpoAvRecordingRef.current.stopAndUnloadAsync();
            }
          } catch {
            /* ignore */
          }
          voiceExpoAvRecordingRef.current = null;
          try {
            if (voiceRecorder.isRecording) {
              await voiceRecorder.stop();
            }
          } catch {
            /* ignore */
          }
          await unloadPreviewAudio();
          await configureConnectPlaybackAudioSessionAsync({ retries: 1 });
        } catch (error) {
          console.warn('[ReactionSheet] voice retake cleanup failed:', error);
        } finally {
          setIsVoiceProcessing(false);
        }
      })();
      return;
    }
    if (reactionMode === 'typed') {
      setCompanionPreviewOpen(false);
      setCompanionPreviewPlaying(false);
      setShowCompanionPreviewReplay(false);
      setTypedPreviewLoading(false);
      companionPreviewStopPendingRef.current = false;
      typedPreviewAudioUriRef.current = null;
      typedPreviewMessageRef.current = null;
      unloadPreviewAudio();
      setTypedMessage('');
      setTypedMessageReady(false);
      void restoreReactionRecordingAudioSession();
      return;
    }
    const restartAt = syncStartTimeMillis ?? trimStartMsRef.current;
    companionPreviewStopPendingRef.current = true;
    recordingSessionIdRef.current += 1;
    isRecordingRef.current = false;
    recordingPromiseRef.current = null;
    cameraRecordingStartedRef.current = false;
    recordingAudioReassertCancelRef.current?.();
    recordingAudioReassertCancelRef.current = null;
    selfieCaptureArmingRef.current = false;
    setIsSelfieCaptureArming(false);
    setIsRecording(false);
    setIsSelfieSaving(false);
    setSelfieCaptureFinalizePending(false);
    setRecordedUri(null);
    setRecordedAudioSnapshot(null);
    setSyncStartTimeMillis(null);
    setSyncEndTimeMillis(null);
    positionMillisRef.current = restartAt;
    setPositionMillis(restartAt);
    setIsPreviewPlaying(false);
    setCompanionPreviewOpen(false);
    companionPreviewOpenRef.current = false;
    companionPreviewPlayingRef.current = false;
    setCompanionPreviewPlaying(false);
    setShowCompanionPreviewReplay(false);
    // IMPORTANT: do NOT clear cameraReady here. The persistent CameraView never
    // remounts and expo-camera does not re-emit onCameraReady when it resumes
    // from an `active` suspend, so clearing readiness would strand the record
    // wait-loop forever (the retake camera-not-ready bug). The session resumes
    // the moment companionPreviewOpen flips false; readiness carries over.
    setIsCameraRestoring(false);
    companionPreviewStartInFlightRef.current = false;
    setIsSelfieRetakePreparing(true);
    try {
      companionSelfiePlayer.pause();
      companionSelfiePlayer.replace(null);
    } catch {
      /* player may be released */
    }

    logReactionDebug('retake:selfie-sync', { isVideoParent });

    // No camera remount: the persistent CameraView simply resumes its capture
    // session now that companionPreviewOpen is false. We just give expo-video a
    // beat to release before we re-enable the record button.
    retakeReleaseTimerRef.current = setTimeout(() => {
      retakeReleaseTimerRef.current = null;
      setIsSelfieRetakePreparing(false);
      companionPreviewStopPendingRef.current = false;
      logReactionDebug('retake:selfie-ready', {});
    }, SELFIE_RETAKE_PLAYER_RELEASE_MS);

    void (async () => {
      try {
        await Promise.race([
          Promise.all([
            companionParentRef.current?.pauseAsync().catch(() => {}),
            videoRef.current?.pauseAsync().catch(() => {}),
            unloadPreviewAudio(),
          ]),
          new Promise<void>((resolve) => setTimeout(resolve, 750)),
        ]);
        if (isVideoParent && restartAt > 0) {
          void commitVideoPosition(restartAt, {
            shouldPlay: false,
            volume: getReactionParentVolume(),
          });
        }
      } catch (error) {
        console.warn('[ReactionSheet] selfie retake cleanup failed:', error);
      }
    })();
  }, [
    commitVideoPosition,
    companionSelfiePlayer,
    getReactionParentVolume,
    isVideoParent,
    reactionMode,
    syncStartTimeMillis,
    unloadPreviewAudio,
    voiceRecorder,
  ]);

  const handleSend = useCallback(() => {
    if (isUploading) return;

    if (isNarrationMode) {
      if (!recordedUri) {
        Alert.alert('Record a Narration', 'Hold the button to record your selfie narration first.');
        return;
      }
      logComposeDiag('narration:complete', { platform: Platform.OS });
      onNarrationComplete?.(recordedUri);
      onClose();
      return;
    }

    if (!currentExplorerId) {
      Alert.alert('Explorer Not Ready', 'Please wait for the Explorer profile to load before sending.');
      return;
    }
    if (!user?.uid) {
      Alert.alert('Sign In Required', 'Please sign in to send a reaction.');
      return;
    }
    if (!activeRelationship?.id) {
      Alert.alert('Unable to Send', 'Your Companion link to this Explorer is missing.');
      return;
    }

    if (reactionMode === 'selfie') {
      if (!recordedUri || syncStartTimeMillis == null) {
        Alert.alert('Unable to Send', 'Reaction sync timing is missing. Please retake your reaction.');
        return;
      }
    } else if (reactionMode === 'typed') {
      if (!typedMessage.trim()) {
        Alert.alert('Add a Message', 'Type a short reaction before sending.');
        return;
      }
    } else if (!voiceRecordedUri) {
      Alert.alert('Record a Message', 'Record a voice reaction before sending.');
      return;
    }

    void (async () => {
      isUploadingRef.current = true;
      setIsUploading(true);
      try {
        logComposeDiag('reaction:send-start', { mode: reactionMode, platform: Platform.OS });
        await prepareReactionForUpload(reactionMode);
        const eventId = await uploadReaction({
          reactionType: reactionMode,
          explorerId: currentExplorerId,
          parentReflectionId,
          syncStartTimeMillis:
            reactionMode === 'selfie'
              ? (syncStartTimeMillis ?? 0)
              : isVideoParent && (reactionMode === 'voice' || reactionMode === 'typed')
                ? trimStartMs
                : 0,
          senderName: activeRelationship.companionName || 'Companion',
          senderId: user.uid,
          activeRelationshipId: activeRelationship.id,
          recordedVideoUri: reactionMode === 'selfie' ? recordedUri ?? undefined : undefined,
          messageText: reactionMode === 'typed' ? typedMessage.trim() : undefined,
          recordedAudioUri: reactionMode === 'voice' ? voiceRecordedUri ?? undefined : undefined,
          parentPosterUri,
        });
        logComposeDiag('reaction:send-success', { mode: reactionMode, eventId, platform: Platform.OS });
        onUploadSuccess?.(parentReflectionId, activeRelationship.id);
        onClose();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to send reaction';
        logComposeDiag('reaction:send-failed', { mode: reactionMode, message, platform: Platform.OS }, 'error');
        console.error('[ReactionSheet] upload failed:', error);
        Alert.alert('Send Failed', message);
      } finally {
        isUploadingRef.current = false;
        if (visibleRef.current) {
          setIsUploading(false);
        }
      }
    })();
  }, [
    activeRelationship,
    currentExplorerId,
    isNarrationMode,
    isUploading,
    isVideoParent,
    onClose,
    onNarrationComplete,
    onUploadSuccess,
    parentPosterUri,
    parentReflectionId,
    prepareReactionForUpload,
    reactionMode,
    recordedUri,
    syncStartTimeMillis,
    trimStartMs,
    typedMessage,
    user?.uid,
    voiceRecordedUri,
  ]);

  const isSelfiePreviewMode = reactionMode === 'selfie' && recordedUri != null;
  const isSelfieTakeComplete = isSelfiePreviewMode && !companionPreviewOpen;
  const isSelfieComposeStage =
    reactionMode === 'selfie' && !companionPreviewOpen && recordedUri == null;
  const isAndroidVideoTypedCompose =
    Platform.OS === 'android' &&
    isVideoParent &&
    !companionPreviewOpen &&
    reactionMode === 'typed';
  const isAndroidVideoVoiceCompose =
    Platform.OS === 'android' &&
    isVideoParent &&
    !companionPreviewOpen &&
    reactionMode === 'voice';
  const isVoicePreviewMode = reactionMode === 'voice' && voiceRecordedUri != null;
  const isVoiceTakeComplete = isVoicePreviewMode && !companionPreviewOpen;
  const isTypedPreviewMode =
    reactionMode === 'typed' && typedMessage.trim().length > 0 && typedMessageReady;
  const isTypedTakeComplete = isTypedPreviewMode && !companionPreviewOpen;
  const isPreviewMode = isSelfiePreviewMode || isVoicePreviewMode || isTypedPreviewMode;
  const isInteractionBusy =
    isUploading ||
    isSelfieSaving ||
    isSelfieRetakePreparing ||
    isSelfieCaptureArming ||
    isVoiceProcessing ||
    isStartingVoiceRecording ||
    isRecording;
  const showCompanionPreviewStage =
    companionPreviewOpen &&
    ((reactionMode === 'selfie' && !!recordedUri) ||
      (reactionMode === 'voice' && !!voiceRecordedUri) ||
      (reactionMode === 'typed' && !!typedMessage.trim()));
  const isSelfieCaptureCameraLive =
    isRecording || isSelfieSaving || selfieCaptureFinalizePending;
  const isCameraGranted =
    cameraPermission?.granted === true || nativeCameraGranted === true;
  // Keep a SINGLE CameraView mounted for the entire selfie session (idle →
  // record → preview → retake). Remounting a CameraView on iOS old-arch
  // reliably fails to fire onCameraReady the second time, which is exactly what
  // broke retake. We never unmount it; we only suspend the capture session via
  // the `active` prop while the preview is open, then resume it on retake.
  const isSelfieCameraMounted =
    visible &&
    reactionMode === 'selfie' &&
    isCameraGranted &&
    (Platform.OS === 'android' || isAppForeground);
  const isSelfieRecordCameraActive =
    isSelfieCameraMounted && !companionPreviewOpen && isAppForeground && !isUploading;
  const isCameraDenied =
    nativeCameraGranted === false && cameraPermission?.granted !== true;
  const canRecordSelfie =
    reactionMode === 'selfie' &&
    !recordedUri &&
    !isSelfieRetakePreparing &&
    !isSelfieCaptureArming &&
    isCameraGranted &&
    (Platform.OS === 'android' || micReady);

  useEffect(() => {
    if (!REACTION_COMPOSE_DIAG || !visible || companionPreviewOpen) return;

    let uiPhase = 'unknown';
    if (reactionMode === 'selfie') {
      if (isSelfieSaving) uiPhase = 'saving';
      else if (isSelfieTakeComplete) uiPhase = 'complete';
      else if (isCameraDenied) uiPhase = 'permission-denied';
      else if (isRecording) uiPhase = cameraReady ? 'recording-pip-live' : 'recording-pip-warming';
      else uiPhase = 'idle-hint';
    } else if (reactionMode === 'typed') {
      if (isTypedTakeComplete) uiPhase = 'complete';
      else if (isTypedKeyboardVisible) uiPhase = 'composing-keyboard-up';
      else uiPhase = 'composing';
    } else if (reactionMode === 'voice') {
      if (isVoiceProcessing) uiPhase = 'processing';
      else if (isVoiceTakeComplete) uiPhase = 'complete';
      else if (isVoiceRecording) uiPhase = 'recording';
      else uiPhase = 'idle';
    }

    const phaseKey = `${reactionMode}:${uiPhase}`;
    if (layoutUiPhaseRef.current === phaseKey) return;
    layoutUiPhaseRef.current = phaseKey;

    logComposeDiag('layout:snapshot', {
      mode: reactionMode,
      uiPhase,
      platform: Platform.OS,
      parentVideo: isVideoParent,
      parentImage: isImageParent,
      androidTypedLayout: isAndroidVideoTypedCompose,
      androidVoiceLayout: isAndroidVideoVoiceCompose,
      selfieComposeStage: isSelfieComposeStage,
      isRecording,
      cameraReady,
      cameraRestoring: isCameraRestoring,
      cameraKey: cameraInstanceKey,
      cameraGranted: isCameraGranted,
      canRecordSelfie,
      typedLen: typedMessage.length,
      typedReady: typedMessageReady,
      typedKeyboardUp: isTypedKeyboardVisible,
      voiceRecording: isVoiceRecording,
      durationMs: durationMillis,
    });
  }, [
    visible,
    companionPreviewOpen,
    reactionMode,
    isSelfieSaving,
    isSelfieTakeComplete,
    isCameraDenied,
    isRecording,
    cameraReady,
    isCameraRestoring,
    cameraInstanceKey,
    isCameraGranted,
    canRecordSelfie,
    isTypedTakeComplete,
    isTypedKeyboardVisible,
    typedMessage.length,
    typedMessageReady,
    isVoiceProcessing,
    isVoiceTakeComplete,
    isVoiceRecording,
    isVideoParent,
    isImageParent,
    isAndroidVideoTypedCompose,
    isAndroidVideoVoiceCompose,
    isSelfieComposeStage,
    durationMillis,
  ]);

  useEffect(() => {
    if (!REACTION_COMPOSE_DIAG || !isSelfieComposeStage) return;
    if (isSelfieCameraMounted) {
      logComposeDiag('selfie:pip-mount', {
        cameraKey: cameraInstanceKey,
        active: isSelfieRecordCameraActive,
        warming: isCameraRestoring || !cameraReady,
        saving: isSelfieSaving,
      });
    } else if (!isRecording && !isSelfieSaving && !isSelfieTakeComplete) {
      logComposeDiag('selfie:pip-placeholder', {});
    }
  }, [
    isSelfieComposeStage,
    isSelfieCameraMounted,
    isSelfieSaving,
    isSelfieTakeComplete,
  ]);

  const scrubDurationMs = Math.max(durationMillis, 1);
  const scrubEndMs = trimEndMs > 0 ? trimEndMs : scrubDurationMs;
  const parentIdleVolume = resolveReactionRecordingVolume({
    muted: false,
    hasHeadphones,
  });
  const parentRecordingVolume = resolveReactionRecordingVolume({
    muted: isParentReflectionMuted,
    hasHeadphones,
  });
  const parentTrimPreviewVolume = resolveReactionRecordingVolume({
    muted: false,
    hasHeadphones,
  });
  const parentVideoMuted = isRecording && isParentReflectionMuted;
  const parentVideoVolume = isRecording
    ? parentRecordingVolume
    : isPreviewPlaying
      ? parentTrimPreviewVolume
      : parentIdleVolume;
  const companionPreviewParentMuted = !companionPreviewPlaying;
  const companionPreviewParentVolumeActive = companionPreviewPlaying
    ? parentTrimPreviewVolume
    : 0;
  // A gentle, non-imposing one-liner that only appears when the parent has audio worth hearing.
  const showAudioHint =
    isVideoParent &&
    !companionPreviewOpen &&
    !isPreviewMode &&
    (reactionMode === 'selfie' || reactionMode === 'voice');
  const muteWhileRecordingHint =
    'Audio will be muted while recording to avoid echo. You can use headphones to hear the audio.';
  const voiceModeHint = isVideoParent
    ? isVoiceRecording
      ? 'The Reflection plays with you. Tap Stop when you’re done.'
      : 'Your message sets how long the Reflection plays.'
    : isVoiceRecording
      ? 'Tap Stop when you’re done.'
      : 'Your voice, not AI — good for quieter places.';
  const renderOriginalAudioToggle = () => (
    <Pressable
      style={styles.originalAudioToggle}
      onPress={toggleParentReflectionMute}
      accessibilityRole="switch"
      accessibilityState={{ checked: isParentReflectionMuted }}
      accessibilityLabel={
        isParentReflectionMuted
          ? `Mute video while recording is on. ${muteWhileRecordingHint} Double tap to turn off.`
          : `Mute video while recording is off. ${muteWhileRecordingHint} Double tap to turn on.`
      }
    >
      <FontAwesome
        name={isParentReflectionMuted ? 'volume-off' : 'volume-up'}
        size={18}
        color={isParentReflectionMuted ? '#7dd3a8' : '#ef4444'}
        style={styles.muteToggleIcon}
      />
      <View style={styles.muteToggleTextBlock}>
        <Text style={styles.originalAudioToggleLabel}>Mute video while recording</Text>
        <Text style={styles.muteToggleHint}>{muteWhileRecordingHint}</Text>
      </View>
      <View
        style={[
          styles.originalAudioTogglePill,
          isParentReflectionMuted
            ? styles.originalAudioTogglePillOn
            : styles.originalAudioTogglePillOff,
        ]}
      >
        <Text
          style={[
            styles.originalAudioToggleState,
            isParentReflectionMuted
              ? styles.originalAudioToggleStateOn
              : styles.originalAudioToggleStateOff,
          ]}
        >
          {isParentReflectionMuted ? 'On' : 'Off'}
        </Text>
      </View>
    </Pressable>
  );

  const handleSelfieCameraReady = useCallback(() => {
    logComposeDiag('selfie:camera-ready', {
      cameraKey: cameraInstanceKeyRef.current,
      pip: true,
    });
    setCameraReady(true);
    setIsCameraRestoring(false);
  }, []);

  const renderSelfiePipOverlay = () => {
    if (reactionMode !== 'selfie') return null;

    if (isSelfieCameraMounted) {
      // The live feed is only revealed while actually recording/saving. When the
      // camera is warm-but-idle (or suspended behind the preview overlay) we keep
      // the same CameraView mounted underneath a placeholder so iOS never has to
      // cold-start a second capture session.
      const showLiveFeed = isSelfieCaptureCameraLive;
      return (
        <View
          style={reactionPipStyles.pipFrame}
          pointerEvents="none"
          collapsable={false}
        >
          <CameraView
            key={cameraInstanceKey}
            ref={cameraRef}
            style={StyleSheet.absoluteFillObject}
            facing="front"
            mode="video"
            mirror={Platform.OS === 'ios'}
            videoQuality="720p"
            active={isSelfieRecordCameraActive}
            onCameraReady={handleSelfieCameraReady}
            onMountError={(event) => {
              logComposeDiag(
                'selfie:camera-mount-error',
                { message: event.message, cameraKey: cameraInstanceKey },
                'error',
              );
              console.warn('[ReactionSheet] camera mount error:', event.message);
              setCameraReady(false);
              setIsCameraRestoring(false);
            }}
          />
          {!showLiveFeed ? (
            <View
              style={[StyleSheet.absoluteFillObject, styles.selfiePipPlaceholder]}
              pointerEvents="none"
            >
              <FontAwesome name="video-camera" size={22} color="rgba(255,255,255,0.45)" />
            </View>
          ) : (isCameraRestoring || !cameraReady) && !isSelfieSaving ? (
            <View style={styles.selfiePipWarmupOverlay} pointerEvents="none">
              <ActivityIndicator color="#fff" size="small" />
            </View>
          ) : null}
        </View>
      );
    }

    return (
      <View
        style={[reactionPipStyles.pipFrame, styles.selfiePipPlaceholder]}
        pointerEvents="none"
      >
        <FontAwesome name="video-camera" size={22} color="rgba(255,255,255,0.45)" />
      </View>
    );
  };

  return (
    <Modal
      visible={visible && hasValidParentMedia}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={handleAbandonReaction}
    >
      <GestureHandlerRootView style={styles.container}>
        <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
          {companionPreviewOpen ? (
            <>
              <Pressable
                style={styles.backButton}
                onPress={closeCompanionPreview}
                disabled={isUploading}
                accessibilityRole="button"
                accessibilityLabel="Back to reaction"
              >
                <FontAwesome name="chevron-left" size={16} color="#fff" />
              </Pressable>
              <Text style={[styles.headerTitle, styles.headerTitleCentered]}>Preview</Text>
              <Pressable
                style={styles.closeButton}
                onPress={handleAbandonReaction}
                disabled={isUploading}
                accessibilityRole="button"
                accessibilityLabel="Close reaction recorder"
              >
                <FontAwesome name="times" size={18} color="#fff" />
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.headerTitle}>
                {isNarrationMode ? 'Bring It to Life' : 'Live Sync Reaction'}
              </Text>
              <Pressable
                style={styles.closeButton}
                onPress={handleAbandonReaction}
                disabled={isUploading}
                accessibilityRole="button"
                accessibilityLabel="Close reaction recorder"
              >
                <FontAwesome name="times" size={18} color="#fff" />
              </Pressable>
            </>
          )}
        </View>

        <KeyboardAvoidingView
          style={styles.sheetBodyKeyboardAvoid}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}
          enabled={Platform.OS === 'ios' && reactionMode === 'typed' && !companionPreviewOpen}
        >
        <View style={styles.reactionStageArea}>
          {showCompanionPreviewStage ? (
            <CompanionPreviewOverlay
              reactionMode={reactionMode}
              isVideoParent={isVideoParent}
              isImageParent={isImageParent}
              parentVideoUrl={parentVideoUrl}
              parentImageUrl={parentImageUrl}
              parentRef={companionParentRef}
              parentMuted={companionPreviewParentMuted}
              parentVolume={companionPreviewParentVolumeActive}
              onParentStatusUpdate={handleCompanionParentStatusUpdate}
              recordedUri={recordedUri}
              selfiePlayer={companionSelfiePlayer}
              companionAvatar={companionAvatar}
              typedMessage={typedMessage}
              typedPreviewLoading={typedPreviewLoading}
              sendHint={companionPreviewSendHint}
            />
          ) : null}
        {/* Compose subtree stays mounted even during preview so the selfie
            CameraView is never torn down (preview renders as an overlay above). */}
        <View
          style={styles.splitPane}
          onLayout={(event) => {
            const { width, height } = event.nativeEvent.layout;
            logComposePaneLayout('split', width, height, reactionMode);
            if (height > 0 && height < 200) {
              logReactionDebug(
                'layout:collapse-detected',
                { pane: 'split', h: Math.round(height), mode: reactionMode },
                'warn',
              );
            }
          }}
        >
          <View
            style={[
              styles.parentVideoPane,
              reactionMode === 'selfie' && styles.parentPaneSelfie,
              reactionMode === 'typed' && styles.parentPaneTyped,
              reactionMode === 'voice' &&
                (isAndroidVideoVoiceCompose
                  ? styles.parentPaneVoiceAndroidVideo
                  : styles.parentPaneVoice),
            ]}
            onLayout={(event) => {
              const { width, height } = event.nativeEvent.layout;
              logComposePaneLayout('parent', width, height, reactionMode);
            }}
          >
            <View style={styles.mediaCard}>
              {isVideoParent ? (
                <>
                  <View
                    style={styles.parentVideoSurface}
                    onLayout={(event) => {
                      const { width, height } = event.nativeEvent.layout;
                      parentVideoWidthRef.current = width;
                      logComposePaneLayout('parentSurface', width, height, reactionMode);
                    }}
                  >
                    <Video
                      ref={videoRef}
                      source={{ uri: parentVideoUrl }}
                      style={styles.parentVideo}
                      resizeMode={ResizeMode.CONTAIN}
                      shouldPlay={false}
                      isLooping={false}
                      isMuted={parentVideoMuted}
                      volume={parentVideoVolume}
                      progressUpdateIntervalMillis={100}
                      onPlaybackStatusUpdate={handlePlaybackStatusUpdate}
                    />
                    {showScrubUi && !isRecording && Platform.OS === 'ios' ? (
                      <>
                        <View style={styles.dragHintOverlay} pointerEvents="none">
                          <Text style={styles.dragHintText}>Drag to set start</Text>
                        </View>
                        <GestureDetector gesture={videoPanGesture}>
                          <View style={styles.parentVideoGestureOverlay} />
                        </GestureDetector>
                      </>
                    ) : showScrubUi && !isRecording ? (
                      <View style={styles.dragHintOverlay} pointerEvents="none">
                        <Text style={styles.dragHintText}>Drag to set start</Text>
                      </View>
                    ) : null}
                    {isRecording && isVideoParent ? (
                      <View style={styles.recordingSyncOverlay} pointerEvents="none">
                        <View style={styles.recordingSyncBadge}>
                          <FontAwesome name="circle" size={10} color="#ff6b6b" />
                          <Text style={styles.recordingSyncText}>Recording with Reflection</Text>
                        </View>
                      </View>
                    ) : null}
                    {renderSelfiePipOverlay()}
                  </View>

                  {showScrubUi && durationMillis > MIN_TRIM_GAP_MS ? (
                    <>
                      <View style={styles.trimSliderWrap}>
                        <VideoTrimSlider
                          durationMs={scrubDurationMs}
                          startMs={trimStartMs}
                          endMs={scrubEndMs}
                          currentTimeMs={positionMillis}
                          onChange={handleTrimChange}
                          onSeek={handleSeek}
                          onScrubStart={handleScrubStart}
                          onScrubEnd={handleScrubEnd}
                        />
                      </View>
                      <View style={styles.playbackControlsRow}>
                        <Pressable
                          style={[styles.playbackControl, styles.playbackControlFlex]}
                          onPress={toggleParentPlayback}
                          disabled={isRecording}
                          accessibilityRole="button"
                          accessibilityLabel={
                            isPreviewPlaying
                              ? 'Pause parent Reflection preview'
                              : 'Play parent Reflection preview'
                          }
                        >
                          <FontAwesome
                            name={isPreviewPlaying ? 'pause' : 'play'}
                            size={14}
                            color="#fff"
                          />
                          <Text style={styles.playbackControlText}>
                            {isPreviewPlaying ? 'Pause preview' : 'Play preview'}
                          </Text>
                        </Pressable>
                      </View>
                    </>
                  ) : isSelfieTakeComplete ? (
                    <Text style={styles.selfiePreviewHint}>
                      Tap Preview below to see how Companions will view your reaction.
                    </Text>
                  ) : null}
                </>
              ) : (
                <View style={styles.parentImageSurface}>
                  <Image
                    source={{ uri: parentImageUrl }}
                    style={styles.parentImage}
                    contentFit="contain"
                  />
                  {renderSelfiePipOverlay()}
                </View>
              )}
            </View>
          </View>

          <View
            style={[
              styles.modeRow,
              reactionMode === 'selfie' && styles.modeRowSelfie,
              reactionMode === 'typed' && styles.modeRowTyped,
              reactionMode === 'voice' && styles.modeRowVoice,
            ]}
            onLayout={(event) => {
              const { width, height } = event.nativeEvent.layout;
              logComposePaneLayout('mode', width, height, reactionMode);
            }}
          >
            {reactionMode === 'typed' ? (
              <TypedComposePane
                typedMessage={typedMessage}
                onChangeTypedMessage={setTypedMessage}
                onCommit={commitTypedMessage}
                isUploading={isUploading}
                isTakeComplete={isTypedTakeComplete}
                isKeyboardVisible={isTypedKeyboardVisible}
              />
            ) : reactionMode === 'voice' ? (
              <VoiceComposePane
                isProcessing={isVoiceProcessing}
                isTakeComplete={isVoiceTakeComplete}
                isRecording={isVoiceRecording}
                isStarting={isStartingVoiceRecording}
                isUploading={isUploading}
                hint={voiceModeHint}
                onStartRecording={() => void handleStartVoiceRecording()}
                onStopRecording={() => void handleStopVoiceRecording()}
              />
            ) : (
              <SelfieComposePane
                isSaving={isSelfieSaving}
                isTakeComplete={isSelfieTakeComplete}
                isCameraDenied={isCameraDenied}
                canAskAgain={cameraPermission?.canAskAgain}
                isImageParent={isImageParent}
                onGrantCameraAccess={() => void handleGrantCameraAccess()}
              />
            )}
          </View>
        </View>
        </View>

        <View style={[styles.interactionFooter, { paddingBottom: insets.bottom }]}>
          {showAudioHint ? renderOriginalAudioToggle() : null}

          {isInteractionBusy && !companionPreviewOpen ? (
            <View style={styles.processingBanner}>
              <ActivityIndicator color="#fff" size="small" />
              <Text style={styles.processingBannerText}>
                {isSelfieRetakePreparing
                  ? 'Preparing camera…'
                  : isSelfieCaptureArming
                    ? 'Starting camera…'
                    : isSelfieSaving
                      ? 'Saving selfie…'
                      : isVoiceProcessing
                        ? 'Processing voice…'
                        : isStartingVoiceRecording
                          ? 'Starting voice…'
                          : isRecording
                            ? 'Recording…'
                            : 'Working…'}
              </Text>
            </View>
          ) : null}

          {!companionPreviewOpen && !isNarrationMode ? (
          <View style={styles.modePicker}>
            {(
              [
                { mode: 'selfie' as const, label: 'Selfie', icon: 'video-camera' as const },
                { mode: 'typed' as const, label: 'Type', icon: 'keyboard-o' as const },
                { mode: 'voice' as const, label: 'Voice', icon: 'microphone' as const },
              ] as const
            ).map(({ mode, label, icon }) => {
              const isActive = reactionMode === mode;
              return (
                <Pressable
                  key={mode}
                  style={[styles.modeButton, isActive && styles.modeButtonActive]}
                  onPress={() => handleReactionModeChange(mode)}
                  disabled={isInteractionBusy || isPreviewMode || isVoiceRecording}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isActive }}
                  accessibilityLabel={`${label} reaction`}
                >
                  <FontAwesome
                    name={icon}
                    size={13}
                    color={isActive ? '#fff' : 'rgba(255,255,255,0.65)'}
                  />
                  <Text style={[styles.modeButtonText, isActive && styles.modeButtonTextActive]}>
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          ) : null}

          {companionPreviewOpen ? (
            <View style={styles.previewActions}>
              {isUploading ? (
                <ActivityIndicator color="#fff" style={styles.uploadingSpinner} />
              ) : null}
              <Pressable
                style={[styles.retakeButton, isUploading && styles.previewButtonDisabled]}
                onPress={handleRetake}
                disabled={isUploading || isInteractionBusy}
                accessibilityRole="button"
                accessibilityLabel="Retake reaction"
              >
                <FontAwesome name="refresh" size={15} color="#fff" />
                <Text style={styles.retakeButtonText}>Retake</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.previewPlayButton,
                  (isUploading || companionPreviewPlaying) && styles.previewButtonDisabled,
                ]}
                onPress={showCompanionPreviewReplay ? replayCompanionPreview : () => void startCompanionPreview()}
                disabled={isUploading || companionPreviewPlaying}
                accessibilityRole="button"
                accessibilityLabel={showCompanionPreviewReplay ? 'Replay reaction preview' : 'Preview reaction'}
              >
                <FontAwesome name={showCompanionPreviewReplay ? 'repeat' : 'play'} size={15} color="#fff" />
                <Text style={styles.previewPlayButtonText}>
                  {showCompanionPreviewReplay ? 'Replay' : 'Preview'}
                </Text>
              </Pressable>
              <Pressable
                style={[styles.sendButton, isUploading && styles.previewButtonDisabled]}
                onPress={handleSend}
                disabled={isUploading}
                accessibilityRole="button"
                accessibilityLabel={
                  isNarrationMode ? 'Add narration to your Reflection' : 'Send reaction'
                }
              >
                <FontAwesome name={isNarrationMode ? 'check' : 'paper-plane'} size={15} color="#fff" />
                <Text style={styles.sendButtonText}>{isNarrationMode ? 'Add' : 'Send'}</Text>
              </Pressable>
            </View>
          ) : isSelfieTakeComplete ? (
            <View style={styles.previewActions}>
              <Pressable
                style={[styles.retakeButton, isInteractionBusy && styles.previewButtonDisabled]}
                onPress={handleRetake}
                disabled={isInteractionBusy}
                accessibilityRole="button"
                accessibilityLabel="Retake reaction"
              >
                <FontAwesome name="refresh" size={15} color="#fff" />
                <Text style={styles.retakeButtonText}>Retake</Text>
              </Pressable>
              <Pressable
                style={[styles.previewPlayButton, styles.previewPlayButtonFlex]}
                onPress={openCompanionPreview}
                accessibilityRole="button"
                accessibilityLabel="Preview reaction"
              >
                <FontAwesome name="play" size={15} color="#fff" />
                <Text style={styles.previewPlayButtonText}>Preview</Text>
              </Pressable>
            </View>
          ) : isVoiceTakeComplete ? (
            <View style={styles.previewActions}>
              <Pressable
                style={[styles.retakeButton, isInteractionBusy && styles.previewButtonDisabled]}
                onPress={handleRetake}
                disabled={isInteractionBusy}
                accessibilityRole="button"
                accessibilityLabel="Retake reaction"
              >
                <FontAwesome name="refresh" size={15} color="#fff" />
                <Text style={styles.retakeButtonText}>Retake</Text>
              </Pressable>
              <Pressable
                style={[styles.previewPlayButton, styles.previewPlayButtonFlex]}
                onPress={openCompanionPreview}
                accessibilityRole="button"
                accessibilityLabel="Preview reaction"
              >
                <FontAwesome name="play" size={15} color="#fff" />
                <Text style={styles.previewPlayButtonText}>Preview</Text>
              </Pressable>
            </View>
          ) : isTypedTakeComplete ? (
            <View style={styles.previewActions}>
              <Pressable
                style={[styles.retakeButton, isInteractionBusy && styles.previewButtonDisabled]}
                onPress={handleRetake}
                disabled={isInteractionBusy}
                accessibilityRole="button"
                accessibilityLabel="Retake reaction"
              >
                <FontAwesome name="refresh" size={15} color="#fff" />
                <Text style={styles.retakeButtonText}>Retake</Text>
              </Pressable>
              <Pressable
                style={[styles.previewPlayButton, styles.previewPlayButtonFlex]}
                onPress={openCompanionPreview}
                accessibilityRole="button"
                accessibilityLabel="Preview reaction"
              >
                <FontAwesome name="play" size={15} color="#fff" />
                <Text style={styles.previewPlayButtonText}>Preview</Text>
              </Pressable>
            </View>
          ) : reactionMode === 'typed' ? null : reactionMode === 'voice' ? null : (
            <Pressable
              onPressIn={handlePressIn}
              onPressOut={handlePressOut}
              disabled={
                isSelfieRetakePreparing ||
                isSelfieSaving ||
                (!canRecordSelfie && !isSelfieCaptureArming && !isRecording)
              }
              android_disableSound
              style={({ pressed }) => [
                styles.recordButton,
                (isRecording || isSelfieCaptureArming) && styles.recordButtonActive,
                (pressed || isRecording || isSelfieCaptureArming) && styles.recordButtonPressed,
                (isSelfieRetakePreparing ||
                  isSelfieSaving ||
                  (!canRecordSelfie && !isSelfieCaptureArming && !isRecording)) &&
                  styles.recordButtonDisabled,
              ]}
              accessibilityRole="button"
              accessibilityLabel={
                isSelfieRetakePreparing
                  ? 'Preparing camera'
                  : isSelfieSaving
                    ? 'Saving reaction'
                    : isRecording || isSelfieCaptureArming
                      ? 'Recording reaction'
                      : isNarrationMode
                        ? 'Hold to record narration'
                        : 'Hold to react'
              }
              accessibilityHint={
                isNarrationMode
                  ? 'Press and hold to record yourself bringing this photo to life'
                  : isImageParent
                    ? 'Press and hold to record your reaction to this photo'
                    : 'Press and hold to record your reaction while the Reflection plays'
              }
            >
              <FontAwesome name="circle" size={14} color="#fff" />
              <Text style={styles.recordButtonText}>
                {isSelfieRetakePreparing
                  ? 'Preparing…'
                  : isSelfieSaving
                    ? 'Saving…'
                    : isRecording || isSelfieCaptureArming
                      ? 'Recording…'
                      : isNarrationMode
                        ? 'Hold to Record'
                        : 'Hold to React'}
              </Text>
            </Pressable>
          )}

          {!companionPreviewOpen ? (
            <TouchableOpacity
              style={styles.infoBtn}
              onPress={openHowItWorks}
              accessibilityRole="button"
              accessibilityLabel="How this works"
            >
              <FontAwesome name="info-circle" size={15} color="#4a90d9" />
              <Text style={styles.infoBtnText}>How this works</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        </KeyboardAvoidingView>

        <Modal
          visible={isInfoOpen}
          animationType="slide"
          transparent
          onRequestClose={closeHowItWorks}
          statusBarTranslucent
        >
          <View style={styles.infoModalRoot}>
            <Pressable style={styles.infoModalBackdrop} onPress={closeHowItWorks} />
            <View style={[styles.infoModalCard, { paddingBottom: Math.max(insets.bottom, 16) + 16 }]}>
              <View style={styles.infoModalHeader}>
                <View style={styles.sheetHandle} />
                <TouchableOpacity
                  onPress={closeHowItWorks}
                  style={styles.infoModalCloseBtn}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  accessibilityRole="button"
                  accessibilityLabel="Close how this works"
                >
                  <FontAwesome name="close" size={18} color="#fff" />
                </TouchableOpacity>
              </View>
              <ScrollView
                style={styles.infoModalScrollHost}
                contentContainerStyle={styles.infoSheetScroll}
                showsVerticalScrollIndicator
              >
                {isNarrationMode ? (
                <>
                <Text style={styles.infoTitle}>Bringing Your Image to Life</Text>
                <Text style={styles.infoSubtitle}>
                  A narration adds your face and voice to a photo. The Explorer sees the photo full
                  screen while your selfie video plays in the corner — like you’re right there
                  telling the story.
                </Text>

                <View style={styles.infoRow}>
                  <View style={styles.infoIconWrap}>
                    <FontAwesome name="video-camera" size={14} color="#4FC3F7" />
                  </View>
                  <View style={styles.infoTextWrap}>
                    <Text style={styles.infoLabel}>Selfie narration</Text>
                    <Text style={styles.infoDesc}>
                      Hold the button and tell the Explorer about this Reflection — who’s in the
                      photo, what was happening, why it matters. When you’re done, tap Preview to see
                      exactly what they will see, then Add to attach it. Your narration replaces the
                      spoken caption; the caption text and Rich Narration still work as usual.
                    </Text>
                  </View>
                </View>

                <View style={styles.infoDivider} />

                <Text style={styles.infoProTip}>
                  Use the ✕ to close without adding a narration, or Retake if you want another try.
                  Your Reflection is still ready to send either way.
                </Text>
                </>
                ) : (
                <>
                <Text style={styles.infoTitle}>Reacting to a Reflection</Text>
                <Text style={styles.infoSubtitle}>
                  A reaction lets you respond in the moment — point something out, share a memory, or
                  just smile back. You can react from the timeline, or tap React while watching a
                  Reflection the moment it moves you. Pick whichever feels easiest; there’s no wrong
                  way.
                </Text>

                <View style={styles.infoRow}>
                  <View style={styles.infoIconWrap}>
                    <FontAwesome name="video-camera" size={14} color="#4FC3F7" />
                  </View>
                  <View style={styles.infoTextWrap}>
                    <Text style={styles.infoLabel}>Selfie</Text>
                    <Text style={styles.infoDesc}>
                      Hold the button to record yourself reacting. On videos, drag to choose where the
                      Reflection starts. When you’re done, tap Preview, then Send.
                    </Text>
                  </View>
                </View>

                <View style={styles.infoRow}>
                  <View style={styles.infoIconWrap}>
                    <FontAwesome name="microphone" size={14} color="#4ade80" />
                  </View>
                  <View style={styles.infoTextWrap}>
                    <Text style={styles.infoLabel}>Voice</Text>
                    <Text style={styles.infoDesc}>
                      Record a short voice message — great for narrating or for quieter places where
                      you’d rather not be on camera. On video Reflections, the clip plays for as long
                      as you talk, not the whole video. Tap Preview, then Send.
                    </Text>
                  </View>
                </View>

                <View style={styles.infoRow}>
                  <View style={styles.infoIconWrap}>
                    <FontAwesome name="keyboard-o" size={14} color="#f39c12" />
                  </View>
                  <View style={styles.infoTextWrap}>
                    <Text style={styles.infoLabel}>Type</Text>
                    <Text style={styles.infoDesc}>
                      Write a short note. We’ll deliver it in your AI voice (the one you picked in
                      Settings). Tap Preview to hear it, then Send.
                    </Text>
                  </View>
                </View>

                <View style={styles.infoDivider} />

                <Text style={styles.infoProTipHeader}>What Preview shows</Text>
                <Text style={styles.infoProTip}>
                  Preview matches what the Explorer will see — the Reflection fills the screen, with
                  your reaction in the corner.
                </Text>
                <Text style={styles.infoProTip}>
                  <Text style={styles.infoProTipStrong}>Selfie:</Text> your selfie video plays in the
                  corner. On video Reflections, the Reflection plays softly on the main screen. On
                  photos, the picture stays on the main screen.
                </Text>
                <Text style={styles.infoProTip}>
                  <Text style={styles.infoProTipStrong}>Voice &amp; Type:</Text> your profile photo
                  appears in the corner while your message plays — your recorded voice for Voice, or
                  your AI voice for Type. Typed messages begin with your name (for example,
                  “Grandad says,”) so the Explorer knows who is speaking. On video Reflections,
                  playback stops when your message ends.
                </Text>
                <Text style={styles.infoProTip}>
                  Use the ✕ to close and discard, or Retake if you want another try. The back arrow in
                  Preview returns you to edit without losing your draft.
                </Text>

                <View style={styles.infoDivider} />

                <Text style={styles.infoProTipHeader}>About sound &amp; echo</Text>
                <Text style={styles.infoProTip}>
                  For Selfie and Voice, the Reflection can keep playing while you record so you can
                  react in sync. The picture is always there to follow along.
                </Text>
                <Text style={styles.infoProTip}>
                  <Text style={styles.infoProTipStrong}>Headphones are the sweet spot:</Text> plug them
                  in, turn on Original audio, and you’ll hear the Reflection clearly with no echo in
                  your recording.
                </Text>
                <Text style={styles.infoProTip}>
                  On speaker, leave Original audio off while you record — the video still plays for
                  sync without bleeding into your reaction.
                </Text>
                </>
                )}
              </ScrollView>
            </View>
          </View>
        </Modal>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  headerTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  headerTitleCentered: {
    flex: 1,
    textAlign: 'center',
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  closeButtonSpacer: {
    width: 36,
    height: 36,
  },
  closeButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  splitPane: {
    flex: 1,
    minHeight: 0,
    paddingHorizontal: 12,
    gap: 10,
  },
  mediaCard: {
    flex: 1,
    minHeight: 0,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#101820',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    position: 'relative',
  },
  // Row 1: the parent Reflection pane. One explicit sizing rule per mode — no shared
  // cross-mode flags. The pane element itself is never swapped, so the Video/CameraView
  // inside stay mounted across mode changes.
  parentVideoPane: {
    minHeight: 0,
    width: '100%',
  },
  parentPaneSelfie: {
    // Fills the stage; the floor keeps the camera PIP from flashing in from a
    // 0-height first layout pass (Samsung).
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minHeight: 168,
  },
  parentPaneTyped: {
    // Fixed strip so the text field below stays visible with the keyboard up
    // (both platforms — Android resize events oscillate with flexible heights).
    flexGrow: 0,
    flexShrink: 0,
    height: 180,
  },
  parentPaneVoice: {
    flexGrow: 1.25,
    flexShrink: 1,
    flexBasis: 0,
    minHeight: 160,
  },
  parentPaneVoiceAndroidVideo: {
    // Android with a video parent: fixed height avoids resize oscillation while recording.
    flexGrow: 0,
    flexShrink: 0,
    height: 320,
  },
  // Row 2: the per-mode compose pane. Content layout lives inside each pane component;
  // these only size the row. minHeight floors mean no mode can ever collapse to 0.
  modeRow: {
    minHeight: 0,
    width: '100%',
  },
  modeRowSelfie: {
    flexGrow: 0,
    flexShrink: 0,
    minHeight: 120,
    maxHeight: 160,
  },
  modeRowTyped: {
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 180,
  },
  modeRowVoice: {
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 200,
  },
  recordingSyncOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 10,
  },
  recordingSyncBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  recordingSyncText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  parentVideoSurface: {
    flex: 1,
    minHeight: 0,
    backgroundColor: '#101820',
    overflow: 'hidden',
    position: 'relative',
  },
  parentVideoGestureOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 2,
    backgroundColor: 'transparent',
  },
  parentImageSurface: {
    flex: 1,
    minHeight: 0,
    backgroundColor: '#101820',
    position: 'relative',
  },
  parentVideo: {
    flex: 1,
    backgroundColor: '#101820',
  },
  parentImage: {
    flex: 1,
    width: '100%',
    height: '100%',
    backgroundColor: '#101820',
  },
  dragHintOverlay: {
    position: 'absolute',
    top: 12,
    alignSelf: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.48)',
  },
  dragHintText: {
    color: 'rgba(255,255,255,0.82)',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  trimSliderWrap: {
    flexShrink: 0,
    paddingTop: 4,
    paddingBottom: 4,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  playbackControlsRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  playbackControl: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 10,
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.12)',
  },
  playbackControlFlex: {
    flex: 1,
  },
  playbackControlText: {
    color: 'rgba(255,255,255,0.88)',
    fontSize: 13,
    fontWeight: '600',
  },
  selfiePreviewHint: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 12,
    textAlign: 'center',
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  selfiePipPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  selfiePipWarmupOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  interactionFooter: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 10,
    gap: 10,
    backgroundColor: '#000',
  },
  modePicker: {
    flexDirection: 'row',
    alignSelf: 'stretch',
    gap: 8,
  },
  modeButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  modeButtonActive: {
    backgroundColor: 'rgba(46, 120, 183, 0.55)',
    borderColor: 'rgba(255,255,255,0.28)',
  },
  modeButtonText: {
    color: 'rgba(255,255,255,0.65)',
    fontSize: 13,
    fontWeight: '600',
  },
  modeButtonTextActive: {
    color: '#fff',
  },
  sendButtonStandalone: {
    alignSelf: 'stretch',
    flex: undefined,
    width: '100%',
    marginBottom: 8,
  },
  recordButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minWidth: 148,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(46, 120, 183, 0.92)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.28)',
  },
  recordButtonActive: {
    backgroundColor: 'rgba(176, 32, 32, 0.95)',
    borderColor: 'rgba(255, 120, 120, 0.65)',
    transform: [{ scale: 1.03 }],
  },
  recordButtonPressed: {
    transform: [{ scale: 1.03 }],
  },
  recordButtonDisabled: {
    opacity: 0.45,
  },
  recordButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  previewActions: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
    width: '100%',
  },
  previewPlayButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.28)',
  },
  previewPlayButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  previewPlayButtonFlex: {
    flex: 1,
  },
  reactionStageArea: {
    flex: 1,
    minHeight: 0,
    position: 'relative',
  },
  sheetBodyKeyboardAvoid: {
    flex: 1,
    minHeight: 0,
  },
  takeCompleteOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(16, 24, 32, 0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    gap: 10,
    zIndex: 2,
  },
  cameraRestoringOverlay: {
    ...StyleSheet.absoluteFillObject,
    // Opaque (matches the media card) so the brief back-camera flash on a fresh iOS mount
    // is fully hidden until the front camera is ready.
    backgroundColor: '#101820',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    zIndex: 3,
  },
  processingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 8,
    marginBottom: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  processingBannerText: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 13,
    fontWeight: '600',
  },
  uploadingSpinner: {
    marginRight: 4,
  },
  previewButtonDisabled: {
    opacity: 0.45,
  },
  retakeButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.28)',
  },
  retakeButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  sendButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: '#2e78b7',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  sendButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
  },
  audioHintBlock: {
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  originalAudioToggle: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginHorizontal: 16,
    marginBottom: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  muteToggleIcon: {
    marginTop: 2,
  },
  muteToggleTextBlock: {
    flex: 1,
    gap: 4,
  },
  muteToggleHint: {
    color: 'rgba(243, 156, 18, 0.72)',
    fontSize: 12,
    lineHeight: 16,
  },
  originalAudioToggleLabel: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 18,
  },
  originalAudioTogglePill: {
    minWidth: 44,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
  },
  originalAudioTogglePillOn: {
    backgroundColor: 'rgba(125,211,168,0.22)',
  },
  originalAudioTogglePillOff: {
    backgroundColor: 'rgba(239,68,68,0.22)',
  },
  originalAudioToggleState: {
    fontSize: 13,
    fontWeight: '700',
  },
  originalAudioToggleStateOn: {
    color: '#7dd3a8',
  },
  originalAudioToggleStateOff: {
    color: '#ef4444',
  },
  audioHintText: {
    flexShrink: 1,
    color: 'rgba(243, 156, 18, 0.72)',
    fontSize: 12,
    lineHeight: 16,
    textAlign: 'center',
  },
  infoBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 6,
    marginTop: 3,
  },
  infoBtnText: {
    color: '#4a90d9',
    fontSize: 14,
    fontWeight: '500',
  },
  infoModalRoot: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  infoModalBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  infoModalCard: {
    backgroundColor: '#1a1a1a',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '85%',
    overflow: 'hidden',
  },
  infoModalHeader: {
    paddingTop: 4,
    paddingBottom: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  sheetHandle: {
    backgroundColor: '#666',
    width: 40,
    height: 5,
    borderRadius: 3,
    alignSelf: 'center',
    marginTop: 8,
    marginBottom: 4,
  },
  infoModalCloseBtn: {
    position: 'absolute',
    top: 6,
    right: 12,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoModalScrollHost: {
    flexGrow: 0,
  },
  infoSheetScroll: {
    paddingHorizontal: 24,
    paddingTop: 18,
    paddingBottom: 24,
  },
  infoTitle: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 6,
  },
  infoSubtitle: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 18,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 16,
  },
  infoIconWrap: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  infoTextWrap: {
    flex: 1,
  },
  infoLabel: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 2,
  },
  infoDesc: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 13,
    lineHeight: 19,
  },
  infoDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.12)',
    marginVertical: 16,
  },
  infoProTipHeader: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 10,
  },
  infoProTip: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 10,
  },
  infoProTipStrong: {
    color: 'rgba(255,255,255,0.7)',
    fontWeight: '600',
  },
});
