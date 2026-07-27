import { shouldShowAnnouncement, normalizeAnnouncementVersion } from '@/utils/announcementGate';

describe('normalizeAnnouncementVersion', () => {
  it('normalizes string and number versions', () => {
    expect(normalizeAnnouncementVersion('  v1  ')).toBe('v1');
    expect(normalizeAnnouncementVersion(4)).toBe('4');
    expect(normalizeAnnouncementVersion('')).toBe('');
    expect(normalizeAnnouncementVersion(null)).toBe('');
  });
});

describe('shouldShowAnnouncement', () => {
  const base = {
    enabled: true,
    version: '2026-07-27',
    title: "What's new",
    body: 'Hello',
  };

  it('hides when disabled', () => {
    expect(shouldShowAnnouncement({ ...base, enabled: false }, null, 'Default')).toEqual({
      show: false,
      reason: 'disabled',
    });
  });

  it('hides when version empty', () => {
    expect(shouldShowAnnouncement({ ...base, version: '' }, null, 'Default').show).toBe(false);
  });

  it('hides when body empty', () => {
    expect(shouldShowAnnouncement({ ...base, body: '  ' }, null, 'Default').show).toBe(false);
  });

  it('hides when already seen', () => {
    expect(shouldShowAnnouncement(base, '2026-07-27', 'Default')).toEqual({
      show: false,
      reason: 'already_seen',
    });
  });

  it('shows for a new version', () => {
    expect(shouldShowAnnouncement(base, 'old', 'Default')).toEqual({
      show: true,
      version: '2026-07-27',
      title: "What's new",
      body: 'Hello',
    });
  });

  it('uses default title when missing', () => {
    const result = shouldShowAnnouncement(
      { enabled: true, version: 4, body: 'Body' },
      null,
      'Heads up',
    );
    expect(result).toEqual({
      show: true,
      version: '4',
      title: 'Heads up',
      body: 'Body',
    });
  });
});
