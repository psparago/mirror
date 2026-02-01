# Project Mirror - Monorepo

Angelshare Companion: A "Directed Social Media" app connecting Cole with his family.

## Structure

```
ProjectMirror/
├── apps/
│   ├── explorer/      # Reflections Explorer (iPad - recipient)
│   └── connect/       # Reflections Connect (iPhone - sender)
├── packages/
│   └── shared/        # Shared code (API endpoints, S3 utilities, types)
├── backend/           # Go Cloud Functions
└── scripts/           # Deployment scripts
```

## Getting Started

### Install Dependencies

From the root directory:
```bash
npm install
```

This will install dependencies for all workspaces (both apps and shared package).

### Running the Apps

**Reflections Explorer (iPad):**
```bash
npm run explorer
# or
cd apps/explorer && npm start
```
- Runs on default Expo port (8081)
- Scan QR code with Expo Go on iPad

**Reflections Connect (iPhone):**
```bash
npm run connect
# or
cd apps/connect && npm start
```
- Runs on port 8082 (to avoid conflicts)
- Scan QR code with Expo Go on iPhone

**Run Both Simultaneously:**
- Open two terminal windows
- Run `npm run explorer` in one
- Run `npm run connect` in the other
- Each generates its own QR code

## Development

### Shared Package

The `@projectmirror/shared` package contains:
- API endpoint URLs
- S3 configuration constants
- S3 upload utilities
- Shared TypeScript types

Both apps import from this package:
```typescript
import { API_ENDPOINTS, S3_CONFIG, uploadPhotoToS3 } from '@projectmirror/shared';
```

### Workspace Commands

From root:
- `npm run cole` - Start Cole app
- `npm run companion` - Start Companion app
- `npm run ios:cole` - Start Cole on iOS simulator
- `npm run ios:companion` - Start Companion on iOS simulator

## Backend

Go Cloud Functions are in `backend/gcloud/functions/`:
- `GetSignedURL` - Generates presigned PUT URLs for S3 uploads (images, metadata, audio)
- `ListMirrorEvents` - Lists event bundles in Cole's inbox and returns presigned GET URLs for:
  - `image.jpg` - The photo
  - `metadata.json` - Event metadata (description, sender, timestamp, audio_url, content_type)
  - `audio.m4a` - Optional audio recording (if present)
- `DeleteMirrorEvent` - Deletes an event bundle (image, metadata, and audio if present)

Deploy with scripts in `scripts/gcloud/`.

