import {
  defaultCaptionSourceForSpoken,
  shouldSkipCaptionTts,
} from '@/utils/captionSourceDefaults';

describe('defaultCaptionSourceForSpoken', () => {
  it('defaults mic context to clean AI caption', () => {
    expect(defaultCaptionSourceForSpoken('audio')).toBe('clean_text');
  });

  it('defaults BITL video to bitl', () => {
    expect(defaultCaptionSourceForSpoken('video')).toBe('bitl');
  });
});

describe('shouldSkipCaptionTts', () => {
  it('skips TTS for human voice and BITL', () => {
    expect(shouldSkipCaptionTts('human_voice')).toBe(true);
    expect(shouldSkipCaptionTts('bitl')).toBe(true);
  });

  it('runs TTS for clean caption and ai', () => {
    expect(shouldSkipCaptionTts('clean_text')).toBe(false);
    expect(shouldSkipCaptionTts('ai')).toBe(false);
  });
});
