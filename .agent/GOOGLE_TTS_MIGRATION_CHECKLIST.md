# Google Journey TTS Migration Checklist

## Environment Snapshot (Current)

- Active gcloud account: `peter.sparago@gmail.com`
- Active project ID: `reflections-1200b`
- Project number: `759023712124`
- Runtime service account (`generate-ai-description`): `759023712124-compute@developer.gserviceaccount.com`

## What Was Updated in Code

- `backend/gcloud/functions/tts.go`
  - Replaced legacy provider HTTP TTS call with Google Cloud Text-to-Speech client.
  - Uses Journey voice: `en-US-Journey-F`.
- Removed legacy TTS-provider references from:
  - `scripts/gcloud/deploy.sh`
  - `scripts/gcloud/deploy-ai-description.sh`
  - `scripts/gcloud/deploy-all.sh`
  - `backend/gcloud/functions/cmd/remaster/main.go`
  - `backend/gcloud/functions/ai.go` comments
- Verified by repo scan: no remaining legacy provider API key references or `tts-1` model references.

## GCP Readiness Checklist

### APIs

Required APIs are enabled in `reflections-1200b`:

- `texttospeech.googleapis.com`
- `cloudfunctions.googleapis.com`
- `run.googleapis.com`
- `cloudbuild.googleapis.com`
- `artifactregistry.googleapis.com`

### IAM

- Runtime service account currently has `roles/editor`.
- This is broad and typically already sufficient for Text-to-Speech usage.
- Optional hardening (least privilege): add `roles/cloudtts.user` and eventually remove broad `roles/editor` after tightening all needed permissions.

## Do You Need to Do Anything Manually?

Short answer: **probably not right now**.

Given the current project state:

- APIs are enabled.
- Runtime SA has broad permissions (`roles/editor`).

So Journey TTS should work after deploy without extra manual IAM setup.

## Optional Hardening Commands (Later)

```bash
gcloud projects add-iam-policy-binding reflections-1200b \
  --member="serviceAccount:759023712124-compute@developer.gserviceaccount.com" \
  --role="roles/cloudtts.user"
```

## Quick Validation Steps

1. Deploy `generate-ai-description`.
2. Trigger a reflection that requires generated audio.
3. Confirm response includes `audio_url` / `deep_dive_audio_url`.
4. If any failure, inspect logs:

```bash
gcloud functions logs read generate-ai-description --gen2 --region=us-central1 --limit=100
```

