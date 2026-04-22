import { Platform } from 'react-native';
import {
  REFLECTION_MAX_VIDEO_SECONDS,
  ensureFileUri,
  materializeVideoSourceToFileAsync,
  probeLocalVideoDurationSeconds,
} from '@/utils/mediaProcessor';

export type { MandatoryTrimResult } from './mandatoryVideoTrim.types';
import type { MandatoryTrimResult } from './mandatoryVideoTrim.types';

type ShowEditorFn = (filePath: string, config: Record<string, unknown>) => void;

function tryLoadShowEditor(): ShowEditorFn | null {
  if (Platform.OS === 'web') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-video-trim') as { showEditor?: ShowEditorFn };
    return typeof mod?.showEditor === 'function' ? mod.showEditor : null;
  } catch (e) {
    console.warn(
      '[mandatoryVideoTrim] react-native-video-trim failed to load (rebuild dev client with native module linked).',
      e,
    );
    return null;
  }
}

function subscribeVideoTrim(
  handler: (event: { name?: string; outputPath?: string }) => void,
): { remove: () => void } {
  // Avoid static import so this file never touches TurboModuleRegistry until subscribe runs.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const RCTDeviceEventEmitter = require('react-native/Libraries/EventEmitter/RCTDeviceEventEmitter')
    .default as { addListener: (event: string, fn: (e: unknown) => void) => { remove: () => void } };
  return RCTDeviceEventEmitter.addListener('VideoTrim', handler as (e: unknown) => void);
}

function toNativeEditorPath(fileUri: string): string {
  return fileUri.startsWith('file://') ? fileUri.slice('file://'.length) : fileUri;
}

/**
 * If the video is longer than {@link REFLECTION_MAX_VIDEO_SECONDS}, opens the native trimmer
 * with a hard max selection window of that length. Cancel dismisses without a file.
 */
export function runMandatoryGalleryTrimIfNeededAsync(pickerUri: string): Promise<MandatoryTrimResult> {
  return (async () => {
    let fileUri: string;
    try {
      fileUri = await materializeVideoSourceToFileAsync(pickerUri);
    } catch (e) {
      console.warn('[mandatoryVideoTrim] materialize failed; trying picker URI for probe:', e);
      fileUri = pickerUri;
    }

    const durationSec = await probeLocalVideoDurationSeconds(fileUri);
    if (!(durationSec > REFLECTION_MAX_VIDEO_SECONDS)) {
      return { kind: 'ok', uri: ensureFileUri(fileUri), wasTrimmed: false };
    }

    if (Platform.OS === 'web') {
      if (__DEV__) {
        console.warn(
          '[mandatoryVideoTrim] Clips over 2 minutes require the native trimmer; not available on web.',
        );
      }
      return { kind: 'cancelled' };
    }

    const showEditor = tryLoadShowEditor();
    if (!showEditor) {
      console.error(
        '[mandatoryVideoTrim] VideoTrim is not in this native binary. Run a new EAS/dev build after adding react-native-video-trim.',
      );
      return { kind: 'cancelled' };
    }

    const fileUriNormalized = fileUri.startsWith('file://') ? fileUri : ensureFileUri(fileUri);
    const nativePath = toNativeEditorPath(fileUriNormalized);

    return await new Promise<MandatoryTrimResult>((resolve) => {
      let settled = false;
      const finish = (r: MandatoryTrimResult) => {
        if (settled) return;
        settled = true;
        sub.remove();
        resolve(r);
      };

      const sub = subscribeVideoTrim((event: { name?: string; outputPath?: string }) => {
        const name = event?.name;
        if (name === 'onFinishTrimming') {
          const p = event.outputPath;
          if (typeof p === 'string' && p.length > 0) {
            const out = p.startsWith('file://') ? p : `file://${p}`;
            finish({ kind: 'ok', uri: out, wasTrimmed: true });
          } else {
            finish({ kind: 'cancelled' });
          }
          return;
        }
        if (name === 'onCancel' || name === 'onCancelTrimming') {
          finish({ kind: 'cancelled' });
          return;
        }
        if (name === 'onError') {
          console.warn('[mandatoryVideoTrim] trim editor error event:', event);
          finish({ kind: 'cancelled' });
        }
      });

      try {
        showEditor(nativePath, {
          maxDuration: REFLECTION_MAX_VIDEO_SECONDS * 1000,
          minDuration: 500,
          headerText: 'Choose up to 2 minutes',
          saveToPhoto: false,
          openShareSheetOnFinish: false,
          openDocumentsOnFinish: false,
          enableSaveDialog: false,
          closeWhenFinish: true,
          trimmingText: 'Trimming & optimizing…',
        });
      } catch (e) {
        console.error('[mandatoryVideoTrim] showEditor failed:', e);
        finish({ kind: 'cancelled' });
      }
    });
  })();
}
