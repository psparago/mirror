import {
  clampNumber,
  clampVideoTrimWindowMs,
  isNativeMediaInterruption,
} from '@/components/reflectionComposer/videoTrim';

describe('clampVideoTrimWindowMs', () => {
  const maxSpan = 60_000;

  it('keeps a valid window inside duration', () => {
    expect(clampVideoTrimWindowMs(1000, 5000, 20_000, maxSpan)).toEqual({
      start: 1000,
      end: 5000,
    });
  });

  it('clamps end to duration', () => {
    expect(clampVideoTrimWindowMs(0, 99_000, 10_000, maxSpan)).toEqual({
      start: 0,
      end: 10_000,
    });
  });

  it('enforces max span by shrinking the end', () => {
    expect(clampVideoTrimWindowMs(0, 120_000, 200_000, maxSpan)).toEqual({
      start: 0,
      end: 60_000,
    });
  });

  it('clamps end to duration without moving start when span fits', () => {
    expect(clampVideoTrimWindowMs(180_000, 250_000, 200_000, maxSpan)).toEqual({
      start: 180_000,
      end: 200_000,
    });
  });

  it('pulls start back when span still exceeds max after end clamp', () => {
    // After end→duration, span is 100s > 60s max → shrink from start side when needed
    expect(clampVideoTrimWindowMs(100_000, 250_000, 200_000, maxSpan)).toEqual({
      start: 100_000,
      end: 160_000,
    });
  });

  it('handles zero duration without throwing', () => {
    const result = clampVideoTrimWindowMs(0, 1000, 0, maxSpan);
    expect(result.end).toBeGreaterThan(result.start);
  });
});

describe('clampNumber', () => {
  it('clamps to bounds', () => {
    expect(clampNumber(5, 0, 10)).toBe(5);
    expect(clampNumber(-1, 0, 10)).toBe(0);
    expect(clampNumber(99, 0, 10)).toBe(10);
  });
});

describe('isNativeMediaInterruption', () => {
  it('detects seeking interrupted errors', () => {
    expect(isNativeMediaInterruption(new Error('Seeking interrupted'))).toBe(true);
    expect(isNativeMediaInterruption(new Error('other'))).toBe(false);
  });
});
