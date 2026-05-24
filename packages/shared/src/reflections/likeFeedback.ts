export type LikeFeedbackMediaKind = 'video' | 'photo';

const LIKE_FEEDBACK_TEMPLATES = [
  "So glad you liked {name}'s {kind}! I'll tell them you liked it!",
  "Awesome! I'll let {name} know you loved this {kind}!",
  "Glad you liked it! I'll tell {name} you loved their {kind}!",
] as const;

export const LIKE_FEEDBACK_UI_COOLDOWN_MS = 2500;

export const DEFAULT_LIKE_FEEDBACK_VOICE = 'en-US-Journey-O';

export function getLikeFeedbackMediaKind(hasVideoUrl: boolean): LikeFeedbackMediaKind {
  return hasVideoUrl ? 'video' : 'photo';
}

/** Uniform random template selection; repeats are expected and fine. */
export function buildLikeFeedbackPhrase(
  companionName: string | undefined | null,
  mediaKind: LikeFeedbackMediaKind
): string {
  const name = typeof companionName === 'string' && companionName.trim()
    ? companionName.trim()
    : 'your Companion';
  const template =
    LIKE_FEEDBACK_TEMPLATES[Math.floor(Math.random() * LIKE_FEEDBACK_TEMPLATES.length)];
  return template.replace('{name}', name).replace('{kind}', mediaKind);
}

export function isLikeFeedbackInCooldown(
  lastTriggeredAtMs: number | undefined,
  nowMs: number = Date.now()
): boolean {
  if (!lastTriggeredAtMs) return false;
  return nowMs - lastTriggeredAtMs < LIKE_FEEDBACK_UI_COOLDOWN_MS;
}
