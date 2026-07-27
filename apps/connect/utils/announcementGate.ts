/**
 * Pure gate for Connect What's New / system message docs.
 * Show only when enabled, version+body present, and version differs from last dismissed.
 */

export function normalizeAnnouncementVersion(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return '';
}

export type AnnouncementDocFields = {
  enabled?: unknown;
  version?: unknown;
  title?: unknown;
  body?: unknown;
};

export type AnnouncementShowDecision =
  | { show: false; reason: 'disabled' | 'missing_version' | 'missing_body' | 'already_seen' }
  | { show: true; version: string; title: string; body: string };

export function shouldShowAnnouncement(
  data: AnnouncementDocFields | null | undefined,
  seenVersion: string | null | undefined,
  defaultTitle: string,
): AnnouncementShowDecision {
  if (!data || data.enabled !== true) {
    return { show: false, reason: 'disabled' };
  }
  const version = normalizeAnnouncementVersion(data.version);
  if (!version) {
    return { show: false, reason: 'missing_version' };
  }
  const body = typeof data.body === 'string' ? data.body.trim() : '';
  if (!body) {
    return { show: false, reason: 'missing_body' };
  }
  if (seenVersion === version) {
    return { show: false, reason: 'already_seen' };
  }
  const title =
    typeof data.title === 'string' && data.title.trim() ? data.title.trim() : defaultTitle;
  return { show: true, version, title, body };
}
