# Cloud Function Logs

Read logs for Gen2 Cloud Functions deployed via `./scripts/gcloud/deploy.sh`.

## Quick start

```bash
# Slow lane aggregator (15-min scheduler)
./scripts/gcloud/logs.sh aggregate-slow-lane-notifications

# Fast lane (Explorer like → immediate push)
./scripts/gcloud/logs.sh send-fast-lane-notification

# Search for cooldown deferrals
./scripts/gcloud/logs.sh aggregate-slow-lane-notifications --filter deferring

# Last hour only (uses Cloud Logging API)
./scripts/gcloud/logs.sh aggregate-slow-lane-notifications --freshness 1h
```

## What varies

| Parameter | Default | Example |
|-----------|---------|---------|
| **function-name** | (required) | `aggregate-slow-lane-notifications` |
| `--project` | `gcloud config` project | `reflections-1200b` |
| `--region` | `us-central1` | same for all functions in this repo |
| `--limit` | `100` | `200` |
| `--filter` | none | `cooldown`, `deferring`, `sent digest` — uses Cloud Logging `SEARCH()` |
| `--freshness` | none | `30m`, `1h`, `1d` |
| `--logging-read` | off | use for time-window queries |

## Function names

Same names as `deploy.sh` / `deploy-all.sh`:

**HTTP (Go)**
- `get-s3-url` — presigned S3 GET/PUT URLs
- `list-mirror-events` — reflection list API
- `delete-mirror-event` — delete reflection assets
- `get-batch-s3-upload-urls` — batch staging upload URLs
- `get-event-bundle` — full event metadata bundle
- `get-voice-sample` — presigned voice preview MP3 URLs
- `synthesize-speech` — ephemeral Google TTS (base64 MP3)
- `delete-companion-account` — companion account deletion
- `unsplash-search` — stock photo search (optional)
- `generate-ai-description` — AI caption/deep dive (optional)

**Firestore triggers (Go)**
- `on-reflection-created` / `on-reflection-updated` — reflection lifecycle

**Notifications (Node)**
- `send-fast-lane-notification` — Explorer like pushes
- `aggregate-slow-lane-notifications` — slow lane digest batching
- `send-posting-reminders` — weekly posting reminders

## Two log backends

**Default (`gcloud functions logs read`)** — simplest tail when no text filter:

```bash
./scripts/gcloud/logs.sh aggregate-slow-lane-notifications --limit 50
```

**With `--filter` or `--freshness`** — uses `gcloud logging read` (Gen2 logs live under Cloud Run):

```bash
./scripts/gcloud/logs.sh aggregate-slow-lane-notifications --freshness 2h --filter cooldown
```

Gen2 functions emit logs under the Cloud Run service name matching the function name.

## Useful slow-lane search strings

| Filter | What you see |
|--------|----------------|
| `deferring` | Companion blocked by digest cooldown (deferred, not marked processed) |
| `sent digest` | Successful digest push |
| `no pending` | Scheduler ran, nothing to do |
| `waiting for debounce` | Uploads still inside debounce window |

## Raw gcloud equivalents

```bash
gcloud functions logs read aggregate-slow-lane-notifications \
  --gen2 --region=us-central1 --project=reflections-1200b --limit=100

gcloud logging read \
  'resource.type="cloud_run_revision"
   resource.labels.service_name="aggregate-slow-lane-notifications"
   textPayload:"deferring"' \
  --project=reflections-1200b --freshness=1h --limit=100
```

## Console

[Cloud Logging](https://console.cloud.google.com/logs) → filter by service name = function name.
