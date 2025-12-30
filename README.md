# Project Mirror - Monorepo

Angelshare Companion: A "Directed Social Media" app connecting Cole with his family.

## Structure

```
ProjectMirror/
├── apps/
│   ├── cole/          # Cole's app (iPad - recipient)
│   └── companion/     # Companion app (iPhone - sender)
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

**Cole App (iPad):**
```bash
npm run cole
# or
cd apps/cole && npm start
```
- Runs on default Expo port (8081)
- Scan QR code with Expo Go on iPad

**Companion App (iPhone):**
```bash
npm run companion
# or
cd apps/companion && npm start
```
- Runs on port 8082 (to avoid conflicts)
- Scan QR code with Expo Go on iPhone

**Run Both Simultaneously:**
- Open two terminal windows
- Run `npm run cole` in one
- Run `npm run companion` in the other
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

Go functions are in `backend/s3-signer/`:
- `GetSignedURL` - Generates presigned PUT URLs for uploads
- `ListMirrorPhotos` - Lists and generates presigned GET URLs for gallery

Deploy with scripts in `scripts/gcloud/`.

