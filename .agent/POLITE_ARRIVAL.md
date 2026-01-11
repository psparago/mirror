# Polite Arrival & Read State Implementation Plan

## 🎯 Goal
Implement a system that respects the user's focus ("Polite Arrival") while tracking their progress ("Read State").

1.  **Read State (Blue Dot):** Persistently track which Reflections have been viewed using local device storage.
2.  **Hot Update Queue (Gold Pill):** When the user is watching a video, hold new incoming content in a "buffer" to prevent interruptions.

---

## 🛠️ Step 1: The Persistence Layer (AsyncStorage)
**Goal:** Create a simple mechanism to save and load the list of "Read" event IDs from the iPad's disk.

* [ ] Install `@react-native-async-storage/async-storage`.
* [ ] In `ColeInboxScreen.tsx`:
    * [ ] Add state: `const [readEventIds, setReadEventIds] = useState<string[]>([]);`
    * [ ] Add `useEffect` to load data on app mount.
    * [ ] Create helper function `markEventAsRead(eventId)` that updates State AND Disk.

## 🧠 Step 2: The Queue Logic (The Brain)
**Goal:** Decouple "Data Arrival" from "UI Update" in `ColeInboxScreen.tsx`.

* [ ] Add state: `const [pendingEvents, setPendingEvents] = useState<Event[]>([]);`
* [ ] Modify the Firestore `onSnapshot` listener:
    * [ ] **Scenario A (Idle):** If `!selectedEvent`, update `events` immediately.
    * [ ] **Scenario B (Busy):** If `selectedEvent`, calculate diff and add to `pendingEvents`.
* [ ] Create `handleFlushUpdates()`:
    * [ ] Merges `pendingEvents` + `events`.
    * [ ] Clears `pendingEvents`.

## 🎨 Step 3: The "Blue Dot" UI
**Goal:** Visual feedback for unread items.

* [ ] In `ReflectedWatchView.tsx`:
    * [ ] Accept `readEventIds` as a prop.
    * [ ] In `renderUpNextItem`:
    * [ ] Check `!readEventIds.includes(item.event_id)`.
    * [ ] If true, render the Blue Dot (`#007AFF`) next to the thumbnail.

## ✨ Step 4: The "Gold Pill" UI (The Toast)
**Goal:** Gentle notification of new content.

* [ ] In `ReflectedWatchView.tsx`:
    * [ ] Accept `pendingCount` and `onFlushUpdates` as props.
    * [ ] Create a new sub-component or render block for the "Pill".
    * [ ] Logic: If `pendingCount > 0`, slide down the Gold Pill (`#FFD700`).
    * [ ] Action: On Press -> Call `onFlushUpdates`.

## 🔄 Step 5: The Auto-Flush
**Goal:** Ensure the grid is always fresh when returning home.

* [ ] In `ColeInboxScreen.tsx`:
    * [ ] Update `closeFullScreen` to call `handleFlushUpdates` automatically.

---

## 📝 TypeScript Concepts We Will Cover
* **Interfaces:** Defining the shape of our props (like Go structs).
* **Generics:** `useState<string[]>` (defining what type of data lives in the state).
* **Async/Await:** Handling disk I/O cleanly.
* **Optional Chaining:** `item?.event_id` (Safe access to properties).