# 🗺️ Looking Glass Roadmap

**Current Version:** 1.0.1 (Prototype)
**Status:** Live Testing (Cole)

---

## 🟢 Phase 1: The "Explorer Feedback" Loop
*Focus: Stabilizing the experience for the current Explorer (Cole) based on real-world usage.*

- [ ] **UX Hotfixes:** Adjust button sizes, colors, and timeouts based on Cole's initial feedback.
- [ ] **Video Player Tuning:** Ensure latency/delay feels natural.
- [ ] **YouTube Handoff:** Validate the "pop to YouTube" flow is smooth and rewarding.
- [ ] **Branch Management:** executing hotfixes on `hotfix/cole-ux` branch to avoid blocking architecture work.

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
- [ ] **Switching View:** Allow a Companion (like Peter) to switch between multiple Explorers (Cole vs. Grandson).

---

## 🔮 Future Concepts (The V2 Parking Lot)

- [ ] **The "Satellite" UI:** Revive the Angelshare concept—Explorer sees themselves in the center, with Companions orbiting as satellites to choose content from.
- [ ] **Smart Reactions:** Using more advanced detection to gauge Explorer delight.

---

## 🧠 The "WOM" Buffer (Write-Only Memory Recovery)
*Reserved for that really important idea that was forgotten during the roadmap meeting.*

- [ ] *[Insert Idea Here when it comes back...]*