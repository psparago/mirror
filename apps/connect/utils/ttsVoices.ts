import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert } from 'react-native';

export const CAPTION_VOICE_STORAGE_KEY = 'tts_voice_caption';
export const DEEP_DIVE_VOICE_STORAGE_KEY = 'tts_voice_deep_dive';
export const DEFAULT_TTS_VOICE = 'en-US-Journey-O';

export const VOICE_OPTIONS = [
  {
    label: 'Journey O',
    value: 'en-US-Journey-O',
    description: 'Softer, lower-pitch, more mature sister voice to Journey-F.',
  },
  {
    label: 'Studio O',
    value: 'en-US-Studio-O',
    description: 'Warm, highly produced long-form female studio voice.',
  },
  {
    label: 'Neural2 C',
    value: 'en-US-Neural2-C',
    description: 'Calm, soothing female voice on Neural2.',
  },
  {
    label: 'Journey D',
    value: 'en-US-Journey-D',
    description: 'Deep, resonant, comforting male voice.',
  },
  {
    label: 'Studio Q',
    value: 'en-US-Studio-Q',
    description: 'Polished, soft-spoken male studio voice.',
  },
  {
    label: 'Casual K',
    value: 'en-US-Casual-K',
    description: 'Conversational, imperfect, casual male style.',
  },
  {
    label: 'Chirp3 Sulafat',
    value: 'en-US-Chirp3-HD-Sulafat',
    description: 'Google-classified warm female voice.',
  },
  {
    label: 'Chirp3 Achernar',
    value: 'en-US-Chirp3-HD-Achernar',
    description: 'Google-classified soft female voice.',
  },
  {
    label: 'Chirp3 Despina',
    value: 'en-US-Chirp3-HD-Despina',
    description: 'Google-classified smooth female voice.',
  },
] as const;

export type VoiceOption = (typeof VOICE_OPTIONS)[number];
export type VoicePickerTarget = 'caption' | 'deep_dive';

export function getVoiceLabel(value: string): string {
  return VOICE_OPTIONS.find((v) => v.value === value)?.label ?? value;
}

export async function loadVoicePreferences(): Promise<{
  captionVoice: string;
  deepDiveVoice: string;
}> {
  try {
    const [savedCaption, savedDeepDive] = await Promise.all([
      AsyncStorage.getItem(CAPTION_VOICE_STORAGE_KEY),
      AsyncStorage.getItem(DEEP_DIVE_VOICE_STORAGE_KEY),
    ]);
    if (!savedCaption) {
      await AsyncStorage.setItem(CAPTION_VOICE_STORAGE_KEY, DEFAULT_TTS_VOICE);
    }
    if (!savedDeepDive) {
      await AsyncStorage.setItem(DEEP_DIVE_VOICE_STORAGE_KEY, DEFAULT_TTS_VOICE);
    }
    return {
      captionVoice: savedCaption || DEFAULT_TTS_VOICE,
      deepDiveVoice: savedDeepDive || DEFAULT_TTS_VOICE,
    };
  } catch {
    return {
      captionVoice: DEFAULT_TTS_VOICE,
      deepDiveVoice: DEFAULT_TTS_VOICE,
    };
  }
}

export async function saveVoicePreference(
  key: typeof CAPTION_VOICE_STORAGE_KEY | typeof DEEP_DIVE_VOICE_STORAGE_KEY,
  value: string,
): Promise<void> {
  try {
    await AsyncStorage.setItem(key, value);
  } catch {
    Alert.alert('Error', 'Failed to save voice preference.');
  }
}
