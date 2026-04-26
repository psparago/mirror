import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import {
  REFLECTION_MAX_VIDEO_SECONDS,
  ensureFileUri,
  materializeVideoSourceToFileAsync,
  probeLocalVideoDurationSeconds,
} from '@/utils/mediaProcessor';

export type { MandatoryTrimResult } from './mandatoryVideoTrim.types';
import type { MandatoryTrimResult } from './mandatoryVideoTrim.types';

type ShowEditorFn = (filePath: string, config: Record<string, unknown>) => void;
type IsValidFileFn = (filePath: string) => boolean | Promise<boolean>;
const TRIM_EDITOR_TIMEOUT_MS = 90_000;

function tryLoadVideoTrimApi(): { showEditor: ShowEditorFn; isValidFile?: IsValidFileFn } | null {
  if (Platform.OS === 'web') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-video-trim') as { showEditor?: ShowEditorFn; isValidFile?: IsValidFileFn };
    if (typeof mod?.showEditor !== 'function') return null;
    return {
      showEditor: mod.showEditor,
      isValidFile: typeof mod?.isValidFile === 'function' ? mod.isValidFile : undefined,
    };
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
    console.log('[mandatoryVideoTrim] start', { pickerUri });
    let fileUri: string;
    try {
      fileUri = await materializeVideoSourceToFileAsync(pickerUri);
      console.log('[mandatoryVideoTrim] materialized source', { fileUri });
    } catch (e) {
      console.warn('[mandatoryVideoTrim] materialize failed; trying picker URI for probe:', e);
      fileUri = pickerUri;
    }

    try {
      const info = await FileSystem.getInfoAsync(ensureFileUri(fileUri), { size: true });
      console.log('[mandatoryVideoTrim] materialized file info', {
        exists: info.exists,
        size: info.exists ? info.size : null,
        uri: ensureFileUri(fileUri),
      });
    } catch (e) {
      console.warn('[mandatoryVideoTrim] file info probe failed', e);
    }

    const durationSec = await probeLocalVideoDurationSeconds(fileUri);
    console.log('[mandatoryVideoTrim] probed durationSec', { durationSec });
    if (!(durationSec > REFLECTION_MAX_VIDEO_SECONDS)) {
      console.log('[mandatoryVideoTrim] skip trim; below duration threshold');
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

    const trimApi = tryLoadVideoTrimApi();
    if (!trimApi) {
      console.error(
        '[mandatoryVideoTrim] VideoTrim is not in this native binary. Run a new EAS/dev build after adding react-native-video-trim.',
      );
      return { kind: 'cancelled' };
    }

    const fileUriNormalized = fileUri.startsWith('file://') ? fileUri : ensureFileUri(fileUri);
    const nativePath = toNativeEditorPath(fileUriNormalized);
    let editorSource = fileUriNormalized;
    if (trimApi.isValidFile) {
      try {
        const uriValid = await Promise.resolve(trimApi.isValidFile(fileUriNormalized));
        const nativeValid = await Promise.resolve(trimApi.isValidFile(nativePath));
        console.log('[mandatoryVideoTrim] isValidFile', {
          fileUriNormalized,
          nativePath,
          uriValid,
          nativeValid,
        });
        if (!uriValid && nativeValid) {
          editorSource = nativePath;
        }
      } catch (e) {
        console.warn('[mandatoryVideoTrim] isValidFile check failed; continuing with file URI', e);
      }
    }
    console.log('[mandatoryVideoTrim] opening editor', {
      nativePath,
      fileUriNormalized,
      editorSource,
      maxDurationMs: REFLECTION_MAX_VIDEO_SECONDS * 1000,
    });

    return await new Promise<MandatoryTrimResult>((resolve) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const finish = (r: MandatoryTrimResult) => {
        if (settled) return;
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        sub.remove();
        resolve(r);
      };

      const sub = subscribeVideoTrim((raw: unknown) => {
        const event =
          raw && typeof raw === 'object'
            ? (raw as { name?: string; outputPath?: string })
            : null;
        if (!event) return;
        const name = event.name;
        console.log('[mandatoryVideoTrim] editor event', event);
        if (name === 'onFinishTrimming') {
          const p = event.outputPath;
          if (typeof p === 'string' && p.length > 0) {
            const out = p.startsWith('file://') ? p : `file://${p}`;
            console.log('[mandatoryVideoTrim] finish success', { outputPath: out });
            finish({ kind: 'ok', uri: out, wasTrimmed: true });
          } else {
            console.warn('[mandatoryVideoTrim] finish without output path');
            finish({ kind: 'cancelled' });
          }
          return;
        }
        if (name === 'onCancel' || name === 'onCancelTrimming') {
          console.log('[mandatoryVideoTrim] user cancelled in editor');
          finish({ kind: 'cancelled' });
          return;
        }
        if (name === 'onError') {
          console.warn('[mandatoryVideoTrim] trim editor error event:', event);
          finish({ kind: 'cancelled' });
        }
      });

      try {
        timeoutId = setTimeout(() => {
          console.warn('[mandatoryVideoTrim] timeout waiting for trim editor events; cancelling');
          finish({ kind: 'timeout' });
        }, TRIM_EDITOR_TIMEOUT_MS);

        trimApi.showEditor(editorSource, {
          maxDuration: REFLECTION_MAX_VIDEO_SECONDS * 1000,
          minDuration: 500,
          headerText: 'Choose up to 2 minutes',
          saveToPhoto: false,
          openShareSheetOnFinish: false,
          openDocumentsOnFinish: false,
          enableSaveDialog: false,
          closeWhenFinish: true,
          trimmingText: 'Trimming & optimizing…',
          alertOnFailToLoad: true,
          alertOnFailTitle: 'Could not load video',
          alertOnFailMessage: 'Please choose another Reflection video format or a shorter clip.',
          alertOnFailCloseText: 'Close',
        });
      } catch (e) {
        console.error('[mandatoryVideoTrim] showEditor failed:', e);
        finish({ kind: 'cancelled' });
      }
    });
  })();
}
