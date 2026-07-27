import type { Event } from '@projectmirror/shared';
import type { VoicePickerTarget } from '@/utils/ttsVoices';

export type ComposerVideoMeta = {
  video_start_ms: number;
  video_end_ms: number;
  thumbnail_time_ms: number | null;
  /** Local JPEG from view-shot when native thumbnails fail (e.g. Space Saver / codec quirks). */
  poster_custom_uri?: string | null;
};

export type CaptionSource = 'human_voice' | 'clean_text' | 'ai' | 'bitl';

export type TriggerMagicOptions = {
  targetCaption?: string;
  targetDeepDive?: string;
  /** Keep staging media when only regenerating TTS (e.g. voice change). */
  preserveStaging?: boolean;
  captionVoice?: string;
  deepDiveVoice?: string;
  /** Staging S3 key for Companion spoken context (mic or BITL video). */
  contextMediaKey?: string;
  skipCaptionTts?: boolean;
  spokenContextTrusted?: boolean;
};

export type ComposerSendPayload = {
  caption: string;
  audioUri: string | null;
  deepDive: string | null;
  videoMeta?: ComposerVideoMeta | null;
  /** Final square photo export (framing baked) to upload instead of the raw source photo. */
  filteredPhotoUri?: string | null;
  /** Local selfie narration video for image reflections (uploaded as a flagged child reaction). */
  narrationUri?: string | null;
};

export type ComposerStage = 'workbench' | 'ai' | 'send';

export type ReflectionComposerProps = {
  mediaUri: string;
  mediaType: 'photo' | 'video';
  initialCaption?: string;
  audioUri?: string | null;
  aiArtifacts?: {
    caption?: string;
    deepDive?: string;
    audioUrl?: string;
    deepDiveAudioUrl?: string;
  };
  isAiThinking: boolean;
  onCancel: () => void;
  onReplaceMedia: () => void;
  onSend: (data: ComposerSendPayload) => void;
  initialVideoMeta?: Partial<ComposerVideoMeta> | null;
  onVideoMetaChange?: (meta: ComposerVideoMeta) => void;
  onTriggerMagic: (options?: TriggerMagicOptions) => Promise<void>;
  isSending: boolean;
  captionVoice?: string;
  deepDiveVoice?: string;
  onCaptionVoiceChange?: (voice: string) => void;
  onDeepDiveVoiceChange?: (voice: string) => void;
  onReplaceMediaFromPreview?: () => void;
  audioRecorder?: any;
  onStartRecording?: () => void;
  onStopRecording?: () => void | Promise<void>;
  companionInReflection?: boolean;
  onCompanionInReflectionChange?: (v: boolean) => void;
  explorerInReflection?: boolean;
  onExplorerInReflectionChange?: (v: boolean) => void;
  peopleContext?: string;
  onPeopleContextChange?: (v: string) => void;
  explorerName?: string;
  stage: ComposerStage;
  onStageChange: (next: ComposerStage) => void;
  replaceMediaBackLabel?: string;
  composerHeaderTitle?: string;
  allowNarration?: boolean;
  captionSource?: CaptionSource;
  onCaptionSourceChange?: (next: CaptionSource) => void;
  isProcessingSpoken?: boolean;
  onSpokenNarration?: (localVideoUri: string) => void;
};

/** Soft guidance only; hard cap lives in mediaProcessor. */
export const SOFT_VIDEO_RECOMMENDED_SECONDS = 60;

export const MIN_PHOTO_SCALE = 0.35;
export const MAX_PHOTO_SCALE = 4;

// Re-export for callers that imported VoicePickerTarget via composer types historically.
export type { VoicePickerTarget, Event };
