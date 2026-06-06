# Reflections Connect — Client Diagnostic Logs

Opt-in diagnostic logging for family testers and production debugging. Logs are captured on the device, uploaded manually by the user, and stored in **Google Cloud Logging** (same project as the backend).

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

# Camera-specific
./scripts/gcloud/logs-client-diagnostics.sh --filter 'camera:ready-timeout' --freshness 1d
./scripts/gcloud/logs-client-diagnostics.sh --filter 'camera:mount-error' --freshness 1d
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

---

## What gets logged automatically

When **Record diagnostic logs** is on:

1. **Console capture** — existing `console.log`, `console.warn`, and `console.error` calls across the app (with redaction of bearer tokens, emails, and URLs with query strings).
2. **Structured reaction/camera events** via `logReactionDebug` in `ReactionSheet`, including:
   - `camera:ready`
   - `camera:mount-error`
   - `camera:schedule-remount` / `camera:remount`
   - `camera:restoring-start`
   - `camera:ready-timeout` (warn after 5s on Android if still “Starting camera…”)
   - Selfie preview lifecycle events

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

| Field | Description |
|-------|-------------|
| `source` | Always `connect-diagnostics` |
| `batchId` | Client-generated; give this to testers to quote back |
| `installId` | Anonymous per-install UUID |
| `firebaseUid` | Authenticated user (server-added) |
| `companionName` / `explorerName` | From active relationship at send time |
| `appVersion`, `buildNumber`, `runtimeVersion` | App build info |
| `platform`, `osVersion`, `deviceModel` | Device info |
| `entryLevel`, `message`, `entryTs` | One row per log line |

---

## Troubleshooting

| Symptom | Check |
|---------|--------|
| Send fails with network error | Is `submit-client-logs` deployed? |
| Send fails 401 | User must be signed in |
| Send fails 429 | Rate limit; wait an hour |
| Empty buffer | Toggle recording on *before* reproducing |
| No logs in GCP | Confirm batch ID, `--freshness`, project `reflections-1200b` |
