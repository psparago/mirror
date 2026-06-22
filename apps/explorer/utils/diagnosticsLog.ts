/**
 * Reflections Explorer diagnostics.
 *
 * Thin wrapper around the shared client-diagnostics module. All buffering,
 * console capture, and upload logic lives in `@projectmirror/shared`; this file
 * only pins Explorer's `source` tag and its high-volume noise filters.
 */
import { configureClientDiagnostics } from '@projectmirror/shared/diagnostics/clientDiagnostics';

configureClientDiagnostics({
  source: 'explorer-diagnostics',
  // Sample the global AppState line so a foreground/background loop cannot fill the buffer.
  appStateSamplePattern: /📱 \[Explorer\] AppState:/,
});

export type {
  DiagnosticBatchIdentity,
  DiagnosticLogEntry,
  DiagnosticLogLevel,
} from '@projectmirror/shared/diagnostics/clientDiagnostics';

export {
  bootstrapDiagnostics,
  diagnosticsAppLog,
  getDiagnosticsBufferSnapshot,
  getDiagnosticsBufferStats,
  getDiagnosticsInstallId,
  isDiagnosticsEnabled,
  sendDiagnosticBatch,
  setDiagnosticsEnabled,
} from '@projectmirror/shared/diagnostics/clientDiagnostics';
