# Project Mirror: Architecture & Context

## 🎯 The Mission ("ColeTube")
We are building a private, accessible social connection platform for Cole, a 15-year-old with Angelman Syndrome (non-verbal, ID).
* **The Goal:** Connection, not consumption.
* **The UX Philosophy:** "Lean Back" experience. Low friction, high agency.
* **The "No Doom Scrolling" Rule:** Content never auto-advances to the next item. It stops and waits for Cole to choose.

## 🏗️ The Monorepo
* **`apps/cole` (Looking Glass):** The consumer app (iPad).
* **`apps/companion`:** The creator app (iPhone) for family.
* **`backend`:** Go (Cloud Functions), Firestore (Signaling), S3 (Storage).
* **`packages/shared`:** Shared TypeScript types and Firebase config.

## 🧠 Key Architecture Patterns

### 1. The "Split View" (Cole App)
* **Layout:** Modeled after classic YouTube iPad.
    * **Left (70%):** Main Stage (Content).
    * **Right (30%):** "Up Next" Sidebar (Static list, does not reorder).
* **Behavior:** Tapping sidebar items switches content immediately.

### 2. The "Context First" Flow
* **Sequence:** When a Video loads, it is **Paused**.
    1.  **TTS Caption:** The description is read aloud first ("Look at this dog").
    2.  **Auto-Play:** ONLY after TTS finishes, the video starts.
    3.  **Kill Switch:** If user switches events, ALL audio/video/timers must die immediately. "Ghost audio" is unacceptable.

### 3. The "One Voice" Rule
* While video is playing, TTS buttons (Captions/Sparkle) are **Disabled** to prevent sensory overload.

### 4. Video Pipeline (The "Dual File" Strategy)
* **Data Structure:** `Event` object has `image_url` (Thumbnail) AND `video_url` (MP4).
* **AI Analysis:** We analyze the **Thumbnail**, not the video, for AI descriptions.

## 🛠️ Technical Decisions & Constraints

### 1. Video Playback
* **Library:** We use `expo-video` (not `expo-av`) for better state management.
* **Constraint:** Videos must be < 10 seconds (cognitive load & performance).

### 2. Camera & Recording (Companion)
* **Strategy:** We use **Native Intents** (`ImagePicker.launchCameraAsync`) for video recording.
* **Reason:** `expo-camera` had critical bugs with stopping recordings. We accept the UX trade-off (leaving the app) for reliability.

### 3. Backend (Go)
* **Storage:** S3 buckets hold `image.jpg`, `video.mp4`, `audio.m4a`, and `metadata.json`.
* **Signaling:** Firestore `signals` collection triggers frontend refreshes via `onSnapshot`.

## 📍 Current Status (Jan 7, 2026)
* **Video:** Fully operational (Record -> Upload -> Play).
* **Next Up:** Handling "Hot Updates" (what happens when a signal arrives while Cole is watching).