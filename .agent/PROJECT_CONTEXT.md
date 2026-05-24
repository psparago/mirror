# Project Mirror: Architecture & Context

## 🎯 The Mission
Project Mirror is the project codename, but the apps are branded as **Reflections Explorer** and **Reflections Companion**.

* **The Goal:** Connection, not consumption. A "directed social media" experience for individuals with cognitive disabilities (referred to as the **Explorer**).
* **The "Reflections" Pattern:** Content shared between Companions and the Explorer are called **Reflections**.
* **The Vision:** Providing a gift to the special needs community to foster high-agency social connection.
* **The UX Philosophy:** "Lean Back" experience. Low friction, high agency.
* **The "No Doom Scrolling" Rule:** Content never auto-advances. It stops and waits for the Explorer to choose.
* **Intellectual Property:** Proprietary patterns for directed social interaction and cognitive-load-optimized interfaces.

## 🏗️ The Monorepo
* **`apps/explorer` (Reflections Explorer):** The consumer app (iPad) for the **Explorer**.
* **`apps/connect` (Reflections Connect):** The app (iPhone) for family, friends, and caregivers.
* **`backend`:** Go (Cloud Functions), Firestore, S3 (Storage).
* **`packages/shared`:** Shared TypeScript types and Firebase config.

## 👥 Roles & Multi-User Governance
* **Roles:**
    * **Explorer:** The primary user of the **Reflections Explorer** app.
    * **Companion:** Family/Friends who record and send "Reflections."
    * **Caregiver:** A special Companion with administrative rights to manage the Explorer's settings from their **Reflections Companion** app.
* **Access Model:** Invitation-only via "Circles of Care."
* **Authentication:** Firebase Auth (Google & Apple).

## 🧠 Key Architecture Patterns

### 1. The "Split View" (Reflections Explorer)
* **Layout:** Modeled after classic YouTube iPad interfaces, optimized for accessibility.
    * **Left (70%):** Main Stage (Reflection playback).
    * **Right (30%):** "Up Next" Sidebar (Static list).

### 2. The Video-First Playback Flow (Reflections Explorer)
* **Sequence:** When a video Reflection loads, the Explorer sees the **poster frame**, then the **trimmed video** plays.
    1.  **Poster → Video:** The Companion-chosen poster appears first, then playback runs within the trim window.
    2.  **Park on Poster:** When the video ends, playback seeks back to the poster frame before narration begins.
    3.  **Caption (Context):** After the video, the Explorer hears the Companion's voice recording or AI-spoken caption. For photo Reflections, caption plays while viewing the image.
    4.  **Rich Narration:** Optional "Tell Me More" deep dive after the caption.
    5.  **Kill Switch:** Immediate cessation of all audio/video on navigation (swiping away or closing).
    6.  **Likes:** Explorer double-taps the Main Stage to like (heart burst + brief TTS feedback); Companions tap hearts on timeline/preview and receive push when the Explorer likes back.

### 3. The "One Voice" Rule
* TTS buttons are disabled during video playback to prevent sensory overload (competing audio tracks).

### 4. Video Pipeline (The "Tri-File" Strategy)
* **Data Structure:** A `Reflection` object typically manages three assets:
    1.  `image_url` (Thumbnail/Poster).
    2.  `video_url` (The main content, MP4).
    3.  `audio_url` (The Companion Intro/Context).
* **AI Analysis:** Thumbnail-based descriptions are generated on upload (used for TTS fallback if no audio intro is provided).

## 🛠️ Technical Decisions & Constraints

### 1. Video Playback
* **Library:** `expo-video` (using Native AVPlayer/ExoPlayer).
* **Constraint:** Videos < 10 seconds (soft target for cognitive load management).

### 2. Camera & Recording
* **Strategy:** Native Intents via `ImagePicker` for **Reflections Companion**.
* **Selfie Mode:** Custom implementation using `expo-camera` in **Reflections Explorer** for reaction shots.

### 3. Backend & Security
* **Storage:** S3 (Media) & Firestore (Metadata/Signals).
* **Long-Term Vision (E2EE):** Content-at-rest encryption where Companions use key pairs. The Explorer's app holds the public key for decryption, ensuring even the backend cannot view the Reflections.

## 📍 Current Status (May 2026)
* **Video:** Fully operational in Explorer and Connect preview/replay. Videos park on the poster frame before post-playback caption narration.
* **Likes:** Companions and Explorer can like Reflections; Explorer double-tap like with TTS feedback; companion push on Explorer likes.
* **Companion App:** Reflection Composer with Sparkle, trim/poster workbench, Preview & Send, and in-app "How it works" guide.
* **In Progress:** Multi-user tenancy refinements and Caregiver admin tools.
* **Roadmap:** E2EE content-at-rest encryption.