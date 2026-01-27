# Explorer Reflection Queuing System

## Overview

The Explorer app uses a **deferred FIFO queue system** for selfie uploads. This decouples selfie capture from S3 upload and Firestore updates, allowing uploads to complete even if the user swipes away or the app is backgrounded.

## High-Level Flow

```
1. Selfie Captured → 2. Image Processed → 3. Job Enqueued → 4. Queue Processes → 5. Upload + Firestore Update
```

### Step-by-Step Process

#### 1. **Selfie Capture** (`captureSelfieResponse`)
- **Location**: `apps/cole/app/(tabs)/index.tsx:958-1026`
- **Trigger**: Called from `MainStageView` when selfie timer expires (5 seconds into video, or after image idle)
- **Actions**:
  - Captures photo with quality `0.3` (line 976)
  - Processes image: resizes to 1080px width, compresses to 0.5 JPEG (lines 985-989)
  - Deletes original photo, keeps processed version (lines 992-998)
  - Generates response event ID (line 1001)

#### 2. **Job Enqueuing** (`enqueueSelfieUpload`)
- **Location**: `apps/cole/app/(tabs)/index.tsx:851-868`
- **Trigger**: Called immediately after image processing (line 1004)
- **Actions**:
  - Reads existing queue from AsyncStorage (line 860)
  - Appends new job to queue (line 862)
  - Writes queue back to AsyncStorage (line 863)
  - Immediately triggers queue processing (line 864)

**Job Structure**:
```typescript
{
  originalEventId: string;      // The reflection event_id
  responseEventId: string;       // Generated response event_id
  localUri: string;             // Processed photo URI (1080px, 0.5 JPEG)
  senderExplorerId: string;     // Explorer who sent
  viewerExplorerId: string;     // Explorer who viewed
  createdAt: number;            // Timestamp
}
```

#### 3. **Queue Processing** (`processSelfieQueue`)
- **Location**: `apps/cole/app/(tabs)/index.tsx:870-955`
- **Trigger**: 
  - Immediately after enqueue (line 864)
  - When app becomes active (AppState listener, line 120)
- **Concurrency Control**: `selfieUploadInFlightRef` prevents parallel processing (line 871-872)
- **Process**:
  1. Reads queue from AsyncStorage (line 875)
  2. Processes jobs FIFO (one at a time)
  3. Validates file exists (lines 881-887)
  4. Gets S3 presigned URL with retry logic (lines 890-906)
  5. Uploads to S3 (lines 908-915)
  6. Deletes local file after successful upload (lines 918-922)
  7. **Atomic Firestore batch update** (lines 924-943):
     - Creates response document in `reflection_responses` collection
     - Updates reflection status to `'responded'` in `reflections` collection
     - Commits both in single atomic batch
  8. Removes job from queue (lines 945-946)
  9. Continues to next job or exits if queue empty

#### 4. **AppState Integration**
- **Location**: `apps/cole/app/(tabs)/index.tsx:114-170`
- **Purpose**: Processes queue when app returns to foreground
- **Implementation**: 
  - Listens for `AppState` changes (line 115)
  - Calls `processSelfieQueue()` when state becomes `'active'` (line 120)
  - Ensures pending uploads complete after app backgrounding

## Key Components

### Storage
- **Queue Key**: `'selfie_upload_queue'` (line 34)
- **Storage**: AsyncStorage (persists across app restarts)
- **Format**: JSON array of job objects

### Concurrency
- **Ref**: `selfieUploadInFlightRef` (line 32)
- **Purpose**: Prevents multiple queue processors from running simultaneously
- **Pattern**: Check flag → set flag → process → clear flag

### Atomic Updates
- **Location**: `apps/cole/app/(tabs)/index.tsx:924-943`
- **Method**: Firestore `writeBatch` (line 925)
- **Documents Updated**:
  1. Response document: `reflection_responses/{originalEventId}` (lines 926-936)
  2. Reflection status: `reflections/{originalEventId}` (lines 938-941)
- **Benefit**: Both updates succeed or fail together (atomicity)

### Error Handling
- **File Missing**: Job is dropped from queue (lines 882-886)
- **Upload Failure**: Job remains in queue for retry (lines 947-950)
- **Retry Logic**: S3 URL fetch retries once with 1.5s delay (lines 890-902)

## Queue Persistence

- **Survives**: App restarts, crashes, backgrounding
- **Storage**: AsyncStorage (device-local, not cloud)
- **Recovery**: Queue processes automatically when app becomes active

## Code References Summary

| Component | Location | Purpose |
|-----------|----------|---------|
| Queue key constant | `index.tsx:34` | AsyncStorage key |
| Concurrency ref | `index.tsx:32` | Prevents parallel processing |
| AppState listener | `index.tsx:114-170` | Triggers processing on foreground |
| Enqueue function | `index.tsx:851-868` | Adds jobs to queue |
| Process function | `index.tsx:870-955` | FIFO queue processor |
| Capture function | `index.tsx:958-1026` | Selfie capture & enqueue |
| Atomic batch update | `index.tsx:924-943` | Firestore atomic commit |

## Design Benefits

1. **Non-blocking**: User can continue interacting while uploads process
2. **Resilient**: Survives app backgrounding/swiping
3. **Atomic**: Firestore updates are all-or-nothing
4. **Efficient**: Only one upload at a time, prevents resource contention
5. **Recoverable**: Failed uploads retry automatically
