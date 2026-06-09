# Reflections Connect — Client Diagnostic Logs

Opt-in diagnostic logging for family testers and production debugging. Logs are captured on the device, uploaded manually by the user, and stored in **Google Cloud Logging** (same project as the backend).

---

## Cloud Logging — one project, different queries

Everything logs to **one** Google Cloud Logging store for project **`reflections-1200b`**. There is no separate “Companion logs database.” What you see depends on **how you filter**.

| What you want | Primary filter | Typical `resource` |
|---------------|----------------|--------------------|
| **Companion app diagnostics** (Ellen’s phone uploads) | `jsonPayload.source="connect-diagnostics"` | Cloud Run service `submit-client-logs` |
| **Backend / server** (APIs, notifications, triggers) | `resource.labels.service_name="FUNCTION-NAME"` | Cloud Run revision for that function |
| **`submit-client-logs` HTTP errors** (upload failed, auth, rate limit) | `resource.labels.service_name="submit-client-logs"` **without** `connect-diagnostics` | Same service, stderr / request logs |

**Companion batches:** the phone POSTs to `submit-client-logs`; that function writes **one Cloud Logging row per log line**, each tagged with `"source": "connect-diagnostics"` in `jsonPayload`. Filtering on `jsonPayload.source` is how you isolate Companion uploads from everything else in the project.

**Backend logs:** see [`scripts/gcloud/LOGS.md`](../scripts/gcloud/LOGS.md) — function names like `aggregate-slow-lane-notifications`, `list-mirror-events`, etc. Those entries generally **do not** have `jsonPayload.source="connect-diagnostics"`.

### Logs Explorer (browser)

| View | Link |
|------|------|
| All Connect client diagnostics (7 days) | [open query](https://console.cloud.google.com/logs/query;query=jsonPayload.source%3D%22connect-diagnostics%22;timeRange=P7D?project=reflections-1200b) |
| `submit-client-logs` service (ingest + errors) | [open query](https://console.cloud.google.com/logs/query;query=resource.type%3D%22cloud_run_revision%22%0Aresource.labels.service_name%3D%22submit-client-logs%22;timeRange=P7D?project=reflections-1200b) |
| Backend example (slow-lane notifications) | [open query](https://console.cloud.google.com/logs/query;query=resource.type%3D%22cloud_run_revision%22%0Aresource.labels.service_name%3D%22aggregate-slow-lane-notifications%22;timeRange=P7D?project=reflections-1200b) |
| Project home (pick Logs Explorer) | [Cloud Logging](https://console.cloud.google.com/logs?project=reflections-1200b) |

Requires Google sign-in with access to `reflections-1200b`.

---

## OTA compatibility

| Component | OTA? | Notes |
|-----------|------|--------|
| Connect app (Settings UI, console capture, camera instrumentation) | **Yes** | Pure JavaScript/TypeScript — ship via `eas update` on the `production` channel |
| Cloud Function `submit-client-logs` | **No** | Deploy once: `./scripts/gcloud/deploy.sh submit-client-logs` |

After the function is deployed, all future app-side improvements can reach testers over OTA without a new store build.

---

## For testers (user instructions)

Share this with family in GroupMe when debugging an issue:

1. Open **Settings** → **Account** tab → **Diagnostic Logs**.
2. Turn on **Record diagnostic logs**.
3. Use the app normally and **reproduce the problem** (e.g. open Reactions, try selfie camera).
4. Return to **Settings** → add an optional note (e.g. “camera stuck on Starting camera…”).
5. Tap **Send diagnostic logs**.
6. Copy the **Batch ID** from the confirmation alert and send it to Peter.

**What is included:** Companion name, Explorer name, device model, app version, and technical log lines (including camera events).

**What is not included:** Reflection message text, photos, videos, or sign-in tokens.

Turn **off** recording when finished if you like; buffered logs stay on the phone until sent or cleared by a successful send.

---

## For Peter — deploy (one time)

```bash
./scripts/gcloud/deploy.sh submit-client-logs
```

Verify the URL matches `packages/shared/src/api/endpoints.ts`:

`https://us-central1-reflections-1200b.cloudfunctions.net/submit-client-logs`

Then OTA the Connect app changes:

```bash
./scripts/eas/ota-update.sh connect
```

---

## Filtering reference (Companion / `connect-diagnostics`)

### `jsonPayload.source` values

| Value | Meaning |
|-------|---------|
| `connect-diagnostics` | **Only production source tag today.** Every line from an uploaded Companion batch uses this. Also used if `submit-client-logs` fails to marshal a log row (rare server error). |

There are no other `source` values written by the app or ingest path today. Backend functions do not use this field for their normal logs.

**Base query (always start here for Companion logs):**

```
jsonPayload.source="connect-diagnostics"
```

### `jsonPayload` field filters

Each uploaded log line repeats batch metadata on every row. Combine with `AND`:

| Field | Type | Example query |
|-------|------|----------------|
| `batchId` | string | `jsonPayload.batchId="mq5j3ru5-n61jowe5"` |
| `installId` | string | `jsonPayload.installId="abc123"` |
| `firebaseUid` | string | `jsonPayload.firebaseUid="UID"` (server-added at upload) |
| `companionName` | string | `jsonPayload.companionName="Auntie Ellen"` |
| `explorerName` | string | `jsonPayload.explorerName="Cole"` |
| `relationshipId` | string | `jsonPayload.relationshipId="..."` |
| `platform` | string | `jsonPayload.platform="android"` or `"ios"` |
| `deviceModel` | string | `jsonPayload.deviceModel="SM-S931U"` |
| `osVersion` | string | `jsonPayload.osVersion="36"` |
| `appVersion` | string | `jsonPayload.appVersion="2.0.1"` |
| `buildNumber` | string | `jsonPayload.buildNumber="14"` |
| `runtimeVersion` | string | `jsonPayload.runtimeVersion="2.0.1"` |
| `otaLabel` | string | `jsonPayload.otaLabel="..."` (when present) |
| `updateChannel` | string | `jsonPayload.updateChannel="production"` |
| `userNote` | string | `jsonPayload.userNote="Camera flashes"` (tester note at send time) |
| `entryLevel` | string | `jsonPayload.entryLevel="error"` — `log`, `warn`, or `error` |
| `entryTs` | ISO string | Device timestamp for that line (not Cloud `timestamp`) |
| `message` | string | Use `SEARCH()` — see below |

**Example — one batch:**

```
jsonPayload.source="connect-diagnostics"
jsonPayload.batchId="PASTE-BATCH-ID"
```

**Example — Android selfie issues for a Companion:**

```
jsonPayload.source="connect-diagnostics"
jsonPayload.companionName="Auntie Ellen"
jsonPayload.platform="android"
SEARCH("selfie:")
```

### Severity / level

Ingest sets Cloud Logging `severity` from the client line level (`LOG`, `WARN`, `ERROR`). You can filter either way:

```
jsonPayload.source="connect-diagnostics"
severity>=ERROR
```

```
jsonPayload.source="connect-diagnostics"
jsonPayload.entryLevel="warn"
```

### `SEARCH()` on message text

Client lines look like `[ReactionSheet] selfie:press-in {...}`. The helper script’s `--filter` adds `SEARCH("...")` to the query.

**Shell helper flags** (`scripts/gcloud/logs-client-diagnostics.sh`):

| Flag | Maps to |
|------|---------|
| `--batch-id ID` | `jsonPayload.batchId="ID"` |
| `--companion NAME` | `jsonPayload.companionName="NAME"` (exact match) |
| `--explorer NAME` | `jsonPayload.explorerName="NAME"` |
| `--filter TEXT` | `SEARCH("TEXT")` |
| `--freshness 1d` | Time window (default `7d`) |
| `--limit N` | Max rows (default `200`) |
| `--download FILE` | JSON export |
| `--project NAME` | GCP project (default `reflections-1200b`) |

**Useful message searches** (prefixes in `jsonPayload.message`):

| Search string | When to use |
|---------------|-------------|
| `selfie:pip-mount` / `selfie:pip-placeholder` | Camera mount/unmount loop (Samsung flash bug) |
| `selfie:app-background-debounce` | Android AppState blip ignored (fix active) |
| `selfie:app-background-cancelled` | Blip recovered before treating as background |
| `selfie:app-background-confirmed` | Real background after debounce |
| `selfie:camera-ready` | `onCameraReady` fired |
| `selfie:camera-ready-fallback` | Timed fallback marked camera ready |
| `selfie:camera-mount-error` | CameraView mount error |
| `selfie:record-camera-timeout` | Camera not ready before record |
| `selfie:record-never-started` | `recordAsync` never started |
| `selfie:record-cancelled` | Record aborted (incl. `before-camera-ready`) |
| `selfie:press-in` / `selfie:press-out` | Hold-to-record gesture |
| `selfie-preview:` | Preview playback (expo-video) |
| `sheet:open` / `sheet:close` | Reaction sheet lifecycle |
| `AppState:` | Global Connect foreground/background (from `_layout.tsx`) |
| `voice:` | Voice reaction pipeline |
| `typed:` | Typed reaction / keyboard |

**Deprecated / not emitted** (older docs — do not use): `camera:ready-timeout`, `camera:mount-error`, `camera:remount`, etc. Current instrumentation uses `selfie:*` prefixes in `ReactionSheet.tsx`.

### Resource filters (optional, narrow further)

Companion diagnostic rows are written by Cloud Run service **`submit-client-logs`**:

```
jsonPayload.source="connect-diagnostics"
resource.type="cloud_run_revision"
resource.labels.service_name="submit-client-logs"
```

Usually unnecessary if `jsonPayload.source` is already set.

### Time range

In Logs Explorer, set the time picker (e.g. **Last 7 days**) or in CLI:

```bash
gcloud logging read '...' --freshness=1d --limit=500
```

Cloud `timestamp` = when the batch was **uploaded**, not when the user reproduced the bug (`entryTs` is the device time per line).

---

## Backend logs (not `connect-diagnostics`)

Server-side logs use **function / service name**, not `jsonPayload.source`. Full list and examples: [`scripts/gcloud/LOGS.md`](../scripts/gcloud/LOGS.md).

**HTTP (Go):** `get-s3-url`, `list-mirror-events`, `delete-mirror-event`, `get-batch-s3-upload-urls`, `get-event-bundle`, `get-voice-sample`, `synthesize-speech`, `delete-companion-account`, `submit-client-logs`, `unsplash-search`, `generate-ai-description`

**Firestore triggers (Go):** `on-reflection-created`, `on-reflection-updated`

**Notifications (Node):** `send-fast-lane-notification`, `aggregate-slow-lane-notifications`, `send-posting-reminders`

**Example — slow-lane digest:**

```
resource.type="cloud_run_revision"
resource.labels.service_name="aggregate-slow-lane-notifications"
SEARCH("deferring")
```

**CLI:**

```bash
./scripts/gcloud/logs.sh aggregate-slow-lane-notifications --freshness 1h --filter deferring
```

---

## For Peter — search logs

### Quick table view

```bash
chmod +x ./scripts/gcloud/logs-client-diagnostics.sh

# Recent client diagnostics (last 7 days)
./scripts/gcloud/logs-client-diagnostics.sh --logging-read

# One batch from a tester
./scripts/gcloud/logs-client-diagnostics.sh --batch-id PASTE-BATCH-ID --freshness 1d

# By Explorer / Companion name
./scripts/gcloud/logs-client-diagnostics.sh --explorer "Mom" --freshness 1d
./scripts/gcloud/logs-client-diagnostics.sh --companion "Grandma" --freshness 1d

# Camera-specific (current event names)
./scripts/gcloud/logs-client-diagnostics.sh --filter 'selfie:record-camera-timeout' --freshness 1d
./scripts/gcloud/logs-client-diagnostics.sh --filter 'selfie:camera-mount-error' --freshness 1d
./scripts/gcloud/logs-client-diagnostics.sh --filter 'selfie:pip-placeholder' --freshness 1d
./scripts/gcloud/logs-client-diagnostics.sh --filter 'selfie:app-background-debounce' --freshness 1d
```

### Download JSON for offline analysis

```bash
./scripts/gcloud/logs-client-diagnostics.sh \
  --batch-id PASTE-BATCH-ID \
  --freshness 1d \
  --download /tmp/connect-diagnostics.json
```

### Raw gcloud (advanced)

```bash
gcloud logging read \
  'jsonPayload.source="connect-diagnostics" AND jsonPayload.batchId="YOUR-BATCH-ID"' \
  --project=reflections-1200b \
  --freshness=1d \
  --limit=500 \
  --format=json
```

Cloud Console: **Logging** → **Logs Explorer** → query:

```
jsonPayload.source="connect-diagnostics"
```

[Open in browser (7 days)](https://console.cloud.google.com/logs/query;query=jsonPayload.source%3D%22connect-diagnostics%22;timeRange=P7D?project=reflections-1200b)

---

## What gets logged automatically

When **Record diagnostic logs** is on:

1. **Console capture** — existing `console.log`, `console.warn`, and `console.error` calls across Connect (with redaction of bearer tokens, emails, and URLs with query strings). Includes `📱 [Connect] AppState: ...` from the tab layout.
2. **Structured reaction events** via `logReactionDebug` / `logComposeDiag` in `ReactionSheet`, including:
   - **Sheet:** `sheet:open`, `sheet:close`, `layout:snapshot`, `layout:pane`
   - **Selfie camera:** `selfie:pip-mount`, `selfie:pip-placeholder`, `selfie:camera-ready`, `selfie:camera-ready-fallback`, `selfie:camera-mount-error`, `selfie:app-background-*`, hold/record lifecycle (`selfie:press-in`, `selfie:capture-armed`, `selfie:record-*`, …)
   - **Selfie preview:** `selfie-preview:*` (expo-video playback)
   - **Retake:** `retake:selfie-sync`, `retake:selfie-ready`
   - **Voice / typed:** `voice:*`, `typed:*`

Buffer limits (device): **500 entries** or **256 KB**, oldest dropped first.

Upload limits (server): **512 KB** body, **500 entries** per batch, **10 batches/user/hour**.

---

## Code map

| File | Role |
|------|------|
| `apps/connect/utils/diagnosticsLog.ts` | Buffer, console patch, send batch |
| `apps/connect/app/_layout.tsx` | Bootstraps diagnostics on launch |
| `apps/connect/app/(tabs)/settings.tsx` | User toggle + send UI |
| `apps/connect/components/ReactionSheet.tsx` | Camera instrumentation |
| `backend/gcloud/functions/submit_client_logs.go` | Ingest + Cloud Logging |
| `packages/shared/src/api/endpoints.ts` | `SUBMIT_CLIENT_LOGS` URL |
| `scripts/gcloud/logs-client-diagnostics.sh` | Query helper |

---

## Log payload fields (Cloud Logging `jsonPayload`)

Each row is **one line from the device**. Batch metadata is duplicated on every row in the same upload.

| Field | Description |
|-------|-------------|
| `source` | Always `connect-diagnostics` for uploaded client lines |
| `batchId` | Client-generated; testers quote this back after **Send diagnostic logs** |
| `installId` | Anonymous per-install UUID (stable across sends from same install) |
| `firebaseUid` | Authenticated user (server-added at upload) |
| `companionName` / `explorerName` | Active relationship at send time |
| `relationshipId` | Firestore relationship id at send time |
| `appVersion`, `buildNumber`, `runtimeVersion` | Native app build info |
| `otaLabel`, `updateChannel` | Expo Updates metadata when present |
| `platform`, `osVersion`, `deviceModel` | Device info |
| `userNote` | Optional note from Settings at send time |
| `entryLevel`, `message`, `entryTs` | One row per log line (`log` / `warn` / `error`) |

---

## Troubleshooting

| Symptom | Check |
|---------|--------|
| Send fails with network error | Is `submit-client-logs` deployed? |
| Send fails 401 | User must be signed in |
| Send fails 429 | Rate limit; wait an hour |
| Empty buffer | Toggle recording on *before* reproducing |
| No logs in GCP | Confirm batch ID, `--freshness`, project `reflections-1200b` |
