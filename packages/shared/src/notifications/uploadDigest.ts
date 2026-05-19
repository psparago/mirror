export type UploadDigestMode = 'off' | 'soon' | 'batched';

export const UPLOAD_DIGEST_HOUR_OPTIONS = [1, 2, 4, 6, 8, 12, 24] as const;
export type UploadDigestHourOption = (typeof UPLOAD_DIGEST_HOUR_OPTIONS)[number];

export const DEFAULT_UPLOAD_DIGEST_MODE: UploadDigestMode = 'batched';
export const DEFAULT_UPLOAD_DIGEST_HOURS: UploadDigestHourOption = 2;

export function normalizeUploadDigestMode(value: unknown): UploadDigestMode {
  if (value === 'off' || value === 'soon' || value === 'batched') {
    return value;
  }
  return DEFAULT_UPLOAD_DIGEST_MODE;
}

export function normalizeUploadDigestHours(value: unknown): UploadDigestHourOption {
  const numeric =
    typeof value === 'number' && Number.isFinite(value)
      ? Math.round(value)
      : typeof value === 'string' && value.trim()
        ? Number.parseInt(value.trim(), 10)
        : NaN;

  if (UPLOAD_DIGEST_HOUR_OPTIONS.includes(numeric as UploadDigestHourOption)) {
    return numeric as UploadDigestHourOption;
  }

  return DEFAULT_UPLOAD_DIGEST_HOURS;
}

export type UploadDigestPrefs = {
  mode: UploadDigestMode;
  hours: UploadDigestHourOption;
  skipDigest: boolean;
  cooldownMillis: number;
};

export function uploadDigestPrefsFromUserData(
  data: Record<string, unknown> | undefined | null
): UploadDigestPrefs {
  const mode = normalizeUploadDigestMode(data?.upload_digest_mode);
  const hours = normalizeUploadDigestHours(data?.upload_digest_hours);

  if (mode === 'off') {
    return { mode, hours, skipDigest: true, cooldownMillis: 0 };
  }

  if (mode === 'soon') {
    return { mode, hours, skipDigest: false, cooldownMillis: 0 };
  }

  return {
    mode,
    hours,
    skipDigest: false,
    cooldownMillis: hours * 60 * 60 * 1000,
  };
}
