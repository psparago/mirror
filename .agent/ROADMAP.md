# 🗺️ Looking Glass Roadmap

**Current Version:** 1.0.1 (Prototype)
**Status:** Live Beta (Cole - Initial 7-min Session Success)

---

## 🟢 Phase 1: The "Cole UX" Refinement (Immediate Priority)
*Focus: Addressing the "Zero Latency" requirement and matching Cole's "YouTube Muscle Memory".*

- [ ] **Zero Latency Player:**
    - [ ] Implement aggressive pre-fetching (buffer next video while current plays).
    - [ ] Enable **Autoplay** on scroll (mute/unmute logic) to prevent "boredom bail-out".
- [ ] **Gesture Alignment (The "YouTube Reflex"):**
    - [ ] **Swipe Down Action:** Implement a specific behavior for swiping down on the player (e.g., minimize video, show "Grid of Reflections").
    - [ ] **Grid View:** A visual gallery of previous/available videos to give him agency when bored with the current one.
- [ ] **Explorer Configuration (The "Spectrum" Toggles):**
    - [ ] Create a local config object (eventually remote) to toggle UI elements.
    - [ ] `showCaptions` (Default: False for Cole).
    - [ ] `showDeepDives` (Default: False for Cole).
    - [ ] `autoplay` (Default: True).
- [ ] **The "Content Desert" Fix:**
    - [ ] **Shuffle/Rediscover Mode:** Inject older "Reflections" back into the feed to solve low content volume.

---

## 🔵 Phase 1.5: The Super User Tools (Jessica/PCA)
*Focus: Empowering the 2-day-a-week PCA to generate content and data.*

- [ ] **Reaction Recorder:** Simple tool for Jessica to film Cole's reaction to a specific video (for Peter's review).
- [ ] **Quick Capture:** Streamline the Companion flow so she can record and send a video in < 3 taps.

---

## 🟡 Phase 2: Identity & Authentication (The "Hard Stop")
*Focus: Removing hardcoded users to enable real scalability.*

- [ ] **Auth Infrastructure:** Implement Firebase Auth (Google Sign-In / Email Link).
- [ ] **User Profiles:** Create Firestore documents for users (Name, Avatar, Role).
- [ ] **Role Management:** Distinguish between `Explorer` (The User) and `Companion` (The Family).
- [ ] **Remove Hardcoding:** Refactor app to read `current_user` from Auth context, not hardcoded strings.

---

## 🟠 Phase 3: Companion Engagement
*Focus: Making the experience rewarding for the family so they keep sending content.*

- [ ] **"Sent Items" History:** Allow Companions to re-watch videos they previously sent.
- [ ] **Feedback Loop:** Show Companions when an Explorer has watched or reacted to their video.
- [ ] **Community Feed (Opt-in):** Allow Companions in the same circle to see each other's videos (e.g., "See what Uncle Mike sent").
- [ ] **Gamification/Stats:** Simple counters (e.g., "5 videos sent this week").

---

## 🔴 Phase 4: Circles & Multi-Tenancy
*Focus: Supporting multiple Explorers (e.g., Cole + Grandson).*

- [ ] **The "Circle" Data Model:**
    - `Explorer` = The Sun (Center of the data universe).
    - `Companion` = The Planet (Orbits specific Explorers).
- [ ] **Onboarding:** "Invite Link" flow to add a Companion to a specific Explorer's circle.
- [ ] **Tenant Isolation:** Ensure content for Explorer A never leaks to Explorer B.

---

## 🔮 Future Concepts (The V2 Parking Lot)

- [ ] **The "Satellite" UI:** Revive the Angelshare concept—Explorer sees themselves in the center, with Companions orbiting as satellites.
- [ ] **Smart Reactions:** Using more advanced detection to gauge Explorer delight.

---

## 🧠 The "WOM" Buffer (Write-Only Memory Recovery)
*Reserved for that really important idea that was forgotten during the roadmap meeting.*

- [ ] *[Insert Idea Here when it comes back...]*