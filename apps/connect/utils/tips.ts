import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Generic one-shot tips for Reflections Connect.
 * Add new tip IDs here; storage remembers which ones the Companion has dismissed.
 */
export type TipId = 'sparkle_tell_the_story';

export type TipContent = {
  title: string;
  body: string;
};

export type TipContext = {
  explorerName?: string;
};

const STORAGE_KEY = '@reflections/connect_tips_seen_v1';

type TipDefinition = {
  title: string;
  body: (ctx?: TipContext) => string;
};

const TIP_DEFS: Record<TipId, TipDefinition> = {
  sparkle_tell_the_story: {
    title: 'Tell the story',
    body: (ctx) => {
      const who = ctx?.explorerName?.trim() || 'the Explorer';
      return (
        `Tap the mic and describe this Reflection — names, places, what’s happening. Uhhs are fine.\n\n` +
        `Sparkle cleans up what you say so the caption and Rich Narration stay accurate for ${who} instead of guessing. ` +
        `Then choose My voice (what they hear) or Clean caption.`
      );
    },
  },
};

type SeenMap = Partial<Record<TipId, true>>;

async function readSeenMap(): Promise<SeenMap> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as SeenMap;
  } catch {
    return {};
  }
}

async function writeSeenMap(map: SeenMap): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

export function getTipContent(id: TipId, ctx?: TipContext): TipContent {
  const def = TIP_DEFS[id];
  return { title: def.title, body: def.body(ctx) };
}

export async function hasSeenTip(id: TipId): Promise<boolean> {
  const map = await readSeenMap();
  return map[id] === true;
}

export async function markTipSeen(id: TipId): Promise<void> {
  const map = await readSeenMap();
  if (map[id]) return;
  map[id] = true;
  await writeSeenMap(map);
}

/** Clears a single tip so it auto-shows again (e.g. from Settings later). */
export async function clearTipSeen(id: TipId): Promise<void> {
  const map = await readSeenMap();
  if (!map[id]) return;
  delete map[id];
  await writeSeenMap(map);
}
