import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Generic one-shot tips for Reflections Connect.
 * Add new tip IDs here; storage remembers which ones the Companion has dismissed.
 */
export type TipId =
  | 'sparkle_tell_the_story'
  | 'workbench_bring_to_life'
  | 'workbench_video_poster';

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
        `By default they hear a clean AI caption voice; switch to My voice only if you want them to hear your recording.`
      );
    },
  },
  workbench_bring_to_life: {
    title: 'Bring your photo to life',
    body: (ctx) => {
      const who = ctx?.explorerName?.trim() || 'the Explorer';
      return (
        `Record a short selfie narration — ${who} sees the photo full screen with you in the corner.\n\n` +
        `Bonus: Sparkle listens to what you say. Names, places, and what’s happening become AI context, ` +
        `so the caption and Rich Narration stay accurate. When you’re done, you’ll land on Sparkle to fine-tune.`
      );
    },
  },
  workbench_video_poster: {
    title: 'Poster & scrubbing',
    body: () =>
      `Poster is the still frame before and after the clip — and what Sparkle’s AI looks at for captions.\n\n` +
      `Drag the gold handles to trim what plays. Tap Poster, then swipe or use the arrows to scrub to a clear frame and Confirm.`,
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

/** Clears all one-shot tip flags so Workbench / Sparkle tips auto-show again. */
export async function clearAllTipsSeen(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}
