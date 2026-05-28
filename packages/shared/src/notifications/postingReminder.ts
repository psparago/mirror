export const POSTING_REMINDER_INACTIVE_DAYS = 7;

export const POSTING_REMINDER_INACTIVE_MS =
  POSTING_REMINDER_INACTIVE_DAYS * 24 * 60 * 60 * 1000;

export const POSTING_REMINDER_NOTIFICATION_TYPE = 'posting_reminder';

export function isPostingReminderInactive(
  baselineMillis: number | null,
  nowMillis: number = Date.now()
): boolean {
  if (baselineMillis === null || !Number.isFinite(baselineMillis)) {
    return false;
  }
  return nowMillis - baselineMillis >= POSTING_REMINDER_INACTIVE_MS;
}

export function isPostingReminderCooldownElapsed(
  lastReminderSentAtMillis: number | null,
  nowMillis: number = Date.now()
): boolean {
  if (lastReminderSentAtMillis === null) {
    return true;
  }
  return nowMillis - lastReminderSentAtMillis >= POSTING_REMINDER_INACTIVE_MS;
}

export function isPostingRemindersEnabled(
  userData: { posting_reminders_enabled?: boolean } | null | undefined
): boolean {
  return userData?.posting_reminders_enabled !== false;
}
