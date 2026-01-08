# Project Mirror: Architecture & Context

## 🎯 The Mission ("Looking Glass")
Project Mirror is the project codename, but the apps are branded as **Looking Glass** (LG) and **Looking Glass Companion** (LGC).
*   **The Goal:** Connection, not consumption. A "directed social media" experience for individuals with cognitive disabilities (referred to as the **Explorer**).
*   **The "Reflections" Pattern:** Content shared between Companions and the Explorer are called **Reflections**.
*   **The Vision:** Providing a gift to the special needs community to foster high-agency social connection.
*   **The UX Philosophy:** "Lean Back" experience. Low friction, high agency.
*   **The "No Doom Scrolling" Rule:** Content never auto-advances. It stops and waits for the Explorer to choose. 
*   **Intellectual Property:** Proprietary patterns for directed social interaction and cognitive-load-optimized interfaces.

## 🏗️ The Monorepo
*   **`apps/cole` (Looking Glass):** The consumer app (iPad) for the **Explorer**.
*   **`apps/companion` (Looking Glass Companion):** The app (iPhone) for family, friends, and caregivers.
*   **`backend`:** Go (Cloud Functions), Firestore, S3 (Storage).
*   **`packages/shared`:** Shared TypeScript types and Firebase config.

## 👥 Roles & Multi-User Governance
*   **Roles:**
    *   **Explorer:** The primary user of the Looking Glass app (e.g., Cole).
    *   **Companion:** Family/Friends who record and send "Reflections."
    *   **Caregiver:** A special Companion with administrative rights to manage the Explorer's Looking Glass settings from their Companion app.
*   **Access Model:** Invitation-only via "Circles of Care."
*   **Authentication:** Firebase Auth (Google & Apple).

## 🧠 Key Architecture Patterns

### 1. The "Split View" (Looking Glass)
*   **Layout:** Modeled after classic YouTube iPad.
    *   **Left (70%):** Main Stage (Reflection playback).
    *   **Right (30%):** "Up Next" Sidebar (Static list).

### 2. The "Context First" Flow
*   **Sequence:** When a Reflection loads, it is **Paused**.
    1.  **Audio Intro (Context):** The context is provided first. This is **preferably a voice recording** from the Companion ("Hey Cole, check out this big dog!"), serving as a personal connection. If no audio is recorded, TTS is used as a fallback.
    2.  **Auto-Play:** ONLY after the audio intro finishes, the video starts.
    3.  **Kill Switch:** Immediate cessation of all audio/video on navigation.

### 3. The "One Voice" Rule
*   TTS buttons are disabled during video playback to prevent sensory overload.

### 4. Video Pipeline (The "Dual File" Strategy)
*   **Data Structure:** `Reflection` object has `image_url` (Thumbnail), `video_url` (MP4), and `audio_url` (Companion Intro).
*   **AI Analysis:** Thumbnail-based descriptions (used for TTS fallback if no audio is provided).

## 🛠️ Technical Decisions & Constraints

### 1. Video Playback
*   **Library:** `expo-video`.
*   **Constraint:** Videos < 10 seconds.

### 2. Camera & Recording
*   **Strategy:** Native Intents via `ImagePicker` for LGC.

### 3. Backend & Security
*   **Storage:** S3 (Media) & Firestore (Metadata/Signals).
*   **Long-Term Vision (E2EE):** Content-at-rest encryption where Companions use key pairs. The Explorer's app holds the public key for decryption, ensuring even the backend cannot view the Reflections.

## 📍 Current Status (Jan 7, 2026)
*   **Video:** Fully operational for single-user flow.
*   **In Progress:** "Hot Updates" for real-time Reflection delivery.
*   **Roadmap:** Multi-user tenancy, Caregiver admin tools, and E2EE.