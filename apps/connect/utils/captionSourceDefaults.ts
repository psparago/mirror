import type { CaptionSource } from '@/components/reflectionComposer/types';

/**
 * After Sparkle Speak / BITL, what the Explorer hears by default.
 * Mic context → clean AI caption TTS. BITL video → selfie narration.
 */
export function defaultCaptionSourceForSpoken(kind: 'audio' | 'video'): CaptionSource {
  return kind === 'video' ? 'bitl' : 'clean_text';
}

/** Skip generating caption TTS when the Explorer will hear human/BITL audio instead. */
export function shouldSkipCaptionTts(source: CaptionSource): boolean {
  return source === 'human_voice' || source === 'bitl';
}
