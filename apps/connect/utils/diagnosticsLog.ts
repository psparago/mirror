import { API_ENDPOINTS } from '@projectmirror/shared';
import { auth } from '@projectmirror/shared/firebase';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Updates from 'expo-updates';
import { AppState, Platform } from 'react-native';

const STORAGE_ENABLED = 'diagnostics_enabled_v1';
const STORAGE_BUFFER = 'diagnostics_buffer_v1';
const STORAGE_INSTALL_ID = 'diagnostics_install_id_v1';

const MAX_ENTRIES = 500;
const MAX_BUFFER_BYTES = 256 * 1024;
const MAX_LINE_CHARS = 2048;
const MAX_USER_NOTE_CHARS = 500;
const PERSIST_DEBOUNCE_MS = 2000;

export type DiagnosticLogLevel = 'log' | 'warn' | 'error';

export type DiagnosticLogEntry = {
  ts: string;
  level: DiagnosticLogLevel;
  message: string;
};

export type DiagnosticBatchIdentity = {
  companionName: string | null;
  explorerName: string | null;
  relationshipId: string | null;
};

type ConsoleFn = typeof console.log;

let buffer: DiagnosticLogEntry[] = [];
let bufferBytes = 0;
let enabled = false;
let consolePatched = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let appStateSubscription: { remove: () => void } | null = null;

const originalConsole: {
  log: ConsoleFn;
  warn: ConsoleFn;
  error: ConsoleFn;
} = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function shouldDropMessage(message: string): boolean {
  if (/bearer\s+[a-z0-9._-]+/i.test(message)) return true;
  if (/https?:\/\/[^\s]*[?][^\s]*/i.test(message)) return true;
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(message)) return true;
  if (/eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/.test(message)) return true;
  return false;
}

function serializeConsoleArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
      if (typeof arg === 'number' || typeof arg === 'boolean' || arg == null) return String(arg);
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

function entryBytes(entry: DiagnosticLogEntry): number {
  return entry.ts.length + entry.level.length + entry.message.length + 32;
}

function trimBufferToLimits(): void {
  while (
    buffer.length > MAX_ENTRIES ||
    (buffer.length > 0 && bufferBytes > MAX_BUFFER_BYTES)
  ) {
    const removed = buffer.shift();
    if (!removed) break;
    bufferBytes -= entryBytes(removed);
  }
}

function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistBuffer();
  }, PERSIST_DEBOUNCE_MS);
}

async function persistBuffer(): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_BUFFER, JSON.stringify(buffer));
  } catch {
    /* best effort */
  }
}

async function loadBufferFromStorage(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_BUFFER);
    if (!raw) return;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return;
    buffer = parsed
      .filter(
        (item): item is DiagnosticLogEntry =>
          item != null &&
          typeof item === 'object' &&
          typeof (item as DiagnosticLogEntry).ts === 'string' &&
          typeof (item as DiagnosticLogEntry).level === 'string' &&
          typeof (item as DiagnosticLogEntry).message === 'string',
      )
      .slice(-MAX_ENTRIES);
    bufferBytes = buffer.reduce((sum, entry) => sum + entryBytes(entry), 0);
    trimBufferToLimits();
  } catch {
    buffer = [];
    bufferBytes = 0;
  }
}

function appendEntry(level: DiagnosticLogLevel, message: string): void {
  if (!enabled) return;
  const normalized = truncate(message.trim(), MAX_LINE_CHARS);
  if (!normalized || shouldDropMessage(normalized)) return;

  const entry: DiagnosticLogEntry = {
    ts: new Date().toISOString(),
    level,
    message: normalized,
  };
  buffer.push(entry);
  bufferBytes += entryBytes(entry);
  trimBufferToLimits();
  schedulePersist();
}

function patchConsole(): void {
  if (consolePatched) return;
  consolePatched = true;

  console.log = (...args: unknown[]) => {
    originalConsole.log(...args);
    appendEntry('log', serializeConsoleArgs(args));
  };
  console.warn = (...args: unknown[]) => {
    originalConsole.warn(...args);
    appendEntry('warn', serializeConsoleArgs(args));
  };
  console.error = (...args: unknown[]) => {
    originalConsole.error(...args);
    appendEntry('error', serializeConsoleArgs(args));
  };
}

function restoreConsole(): void {
  if (!consolePatched) return;
  console.log = originalConsole.log;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  consolePatched = false;
}

export async function getDiagnosticsInstallId(): Promise<string> {
  const existing = await AsyncStorage.getItem(STORAGE_INSTALL_ID);
  if (existing) return existing;
  const id = generateId();
  await AsyncStorage.setItem(STORAGE_INSTALL_ID, id);
  return id;
}

export async function isDiagnosticsEnabled(): Promise<boolean> {
  const value = await AsyncStorage.getItem(STORAGE_ENABLED);
  return value === 'true';
}

export async function setDiagnosticsEnabled(on: boolean): Promise<void> {
  enabled = on;
  await AsyncStorage.setItem(STORAGE_ENABLED, on ? 'true' : 'false');
  if (on) {
    patchConsole();
  } else {
    restoreConsole();
  }
}

export function getDiagnosticsBufferSnapshot(): DiagnosticLogEntry[] {
  return [...buffer];
}

export async function getDiagnosticsBufferStats(): Promise<{
  entryCount: number;
  approxBytes: number;
}> {
  return { entryCount: buffer.length, approxBytes: bufferBytes };
}

/** Structured log — always mirrors to console and buffers when diagnostics are enabled. */
export function diagnosticsAppLog(
  tag: string,
  step: string,
  detail?: Record<string, string | number | boolean | null | undefined>,
  level: DiagnosticLogLevel = 'log',
): void {
  const prefix = `[${tag}] ${step}`;
  const detailText =
    detail && Object.keys(detail).length > 0
      ? ` ${JSON.stringify(detail)}`
      : '';
  const line = `${prefix}${detailText}`;
  if (enabled || __DEV__) {
    if (level === 'warn') originalConsole.warn(line);
    else if (level === 'error') originalConsole.error(line);
    else originalConsole.log(line);
  }
  appendEntry(level, line);
}

async function buildAppContext() {
  const extra = Constants.expoConfig?.extra as { otaLabel?: string } | undefined;
  return {
    version: Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? 'unknown',
    buildNumber: Application.nativeBuildVersion ?? 'unknown',
    runtimeVersion: Updates.runtimeVersion ?? Constants.expoConfig?.version ?? 'unknown',
    otaLabel: extra?.otaLabel ?? null,
    updateChannel: Updates.channel ?? null,
    platform: Platform.OS as 'ios' | 'android',
    osVersion: String(Platform.Version),
    deviceModel: Device.modelName ?? Device.deviceName ?? null,
  };
}

export async function sendDiagnosticBatch(options: {
  identity: DiagnosticBatchIdentity;
  userNote?: string;
}): Promise<{ batchId: string; accepted: number }> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Sign in required to send diagnostic logs.');
  }

  await persistBuffer();

  const entries = getDiagnosticsBufferSnapshot();
  if (entries.length === 0) {
    throw new Error('No diagnostic logs are buffered. Turn on recording and use the app first.');
  }

  const batchId = generateId();
  const userNote = options.userNote?.trim()
    ? truncate(options.userNote.trim(), MAX_USER_NOTE_CHARS)
    : undefined;

  const payload = {
    batchId,
    sentAt: new Date().toISOString(),
    installId: await getDiagnosticsInstallId(),
    companionName: options.identity.companionName,
    explorerName: options.identity.explorerName,
    relationshipId: options.identity.relationshipId,
    app: await buildAppContext(),
    userNote,
    entries,
  };

  const token = await user.getIdToken();
  const response = await fetch(API_ENDPOINTS.SUBMIT_CLIENT_LOGS, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const body = (await response.json().catch(() => null)) as
    | { batchId?: string; accepted?: number; error?: string }
    | null;

  if (!response.ok) {
    throw new Error(body?.error ?? `Upload failed (${response.status})`);
  }

  buffer = [];
  bufferBytes = 0;
  await AsyncStorage.removeItem(STORAGE_BUFFER);

  return {
    batchId: body?.batchId ?? batchId,
    accepted: body?.accepted ?? entries.length,
  };
}

export async function bootstrapDiagnostics(): Promise<void> {
  enabled = await isDiagnosticsEnabled();
  await loadBufferFromStorage();
  if (enabled) patchConsole();

  if (appStateSubscription) {
    appStateSubscription.remove();
  }
  appStateSubscription = AppState.addEventListener('change', (state) => {
    if (state === 'background' || state === 'inactive') {
      void persistBuffer();
    }
  });
}
