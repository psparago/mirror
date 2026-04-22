export type MandatoryTrimResult =
  | { kind: 'ok'; uri: string; wasTrimmed: boolean }
  | { kind: 'cancelled' };
