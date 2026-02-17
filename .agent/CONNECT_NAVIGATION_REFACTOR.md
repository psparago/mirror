# Reflections Connect Navigation Refactor — Summary for LLM Context

## High-Level Goal

- **Before:** Home screen was a dashboard with three big buttons (Camera, Gallery, Search). Timeline was a separate tab.
- **After:** Home screen is the **Timeline**. Creation is triggered by a **FAB** that opens a **bottom sheet** (“Create a Reflection”). From there the user goes to Camera / Gallery / Search, then to the **Composer**, then back to the Timeline.

---

## Main Pieces

### 1. `apps/connect/app/(tabs)/index.tsx` — New Home Screen

- Renders the timeline (`SentTimelineScreen`) plus a FAB and `CreationModal`.
- FAB opens the creation flow by setting `creationModalVisible = true`.
- When `creationModalVisible` is true, header and tab bar are hidden so the creation overlay can be full-screen.

### 2. `apps/connect/components/CreationModal.tsx` — Central Creation UI

- **Two phases:** `'picker'` (bottom sheet with three buttons) and `'creating'` (full-screen overlay: either “Opening creation tools…” or the Composer).
- **Bottom sheet** (e.g. `@gorhom/bottom-sheet`): only shown when `phase === 'picker'` and `visible`; contains “Create a Reflection”, “Posting as {name}”, and Camera / Gallery / Search buttons.
- **Full-screen overlay:** a single **absolutely positioned `View`** (not a React Native `Modal`), with `zIndex: 9999`, that shows either the “Opening creation tools…” gradient screen or the `ReflectionComposer`.
- Visibility is driven by booleans: `showPicker`, `showFullScreenOverlay`, `showComposer`, `showCreatingWait`, so there’s one consistent render tree and no conditional early returns that change hook order.

---

## Transfer: Bottom Sheet → Camera / Gallery / Search

- User taps Camera, Gallery, or Search in the bottom sheet.
- Handler (e.g. `beginSourceFlow`) does:
  - `sheetRef.current?.close()` so the sheet dismisses immediately.
  - `router.push('/camera')` (or `/gallery`, `/search`) so a **fullScreenModal** (or equivalent) opens.
- A ref (e.g. `sourceTransitionLockRef`) can be used so the sheet’s `onChange` doesn’t reopen the sheet during this transition.
- **No second `Modal`** is shown here — only the native full-screen route. The creation overlay stays hidden until the user returns (see below).

---

## Transfer: Camera / Gallery / Search → Composer

- When the user picks media (e.g. takes a photo or selects from gallery), that screen calls the **ReflectionMediaContext** to **set pending media** (e.g. `setPendingMedia(...)`), then typically `router.back()` to return to the tab screen.
- **CreationModal** does **not** consume that media while the camera/gallery/search screen is still focused. It uses **`useIsFocused()`** from React Navigation: the effect that calls `consumePendingMedia()` and then shows the Composer only runs when **`isFocused` is true**. So when the user comes back from the camera/gallery/search route, the tab gains focus, then the effect runs: it consumes the pending media, updates local state (e.g. `photo`, `phase = 'creating'`), and the full-screen overlay appears with the Composer.
- **Critical:** The Composer is **not** implemented as a React Native `<Modal>`. It lives in the same **absolute full-screen `View`** as the “Opening creation tools…” screen. That avoids a second native modal (e.g. a second `UIWindow` on iOS) stacking with the camera’s modal; that stacking was what caused the “dead” screen (invisible modal blocking touches) when the Composer was in a `<Modal>`.

---

## Transfer: Composer → Back to Timeline

- **Cancel:** User taps cancel; `CreationModal`’s `handleClose` runs: clears photo state, calls `sheetRef.current?.close()`, and `onClose()` so the parent sets `creationModalVisible = false`. The overlay and sheet are both gone; user sees Timeline.
- **Send:** After a successful send (e.g. `uploadEventBundle` success), the same cleanup runs: `sheetRef.current?.close()` and `onClose()`. **Do not** set `phase` back to `'picker'` in that same tick — that would briefly make `showPicker` true again and flash the sheet. Phase is reset only when the user opens the flow again (e.g. via a `[visible]` effect that sets `phase = 'picker'` when `visible` becomes true).
- Hiding header and tab bar is driven by `creationModalVisible` in the parent; when `onClose()` runs, that becomes false and the header/tab bar reappear.

---

## Deep Linking

- Links like `/(tabs)?action=camera` (or `gallery`/`search`) are handled in the tab **index** screen. A `useEffect` reads `params.action`, sets `creationModalVisible = true` and `initialAction` to that action, then clears the param. `CreationModal` receives `initialAction` and, when the picker is shown, triggers the corresponding flow (e.g. `beginSourceFlow('/camera')`) so the right screen opens without the user tapping the button.

---

## Auto-Open When Media Is Pending

- If the app or tab remounts after the user picked media (e.g. from gallery) but before the Composer was shown, the index screen has an effect that watches **`pendingMedia`** from ReflectionMediaContext. If `pendingMedia` is set and `creationModalVisible` is false, it sets `creationModalVisible = true`. That way the CreationModal mounts, the `isFocused` + `consumePendingMedia` effect runs, and the user still lands in the Composer.

---

## Design Decisions (for Consistency)

- **Single full-screen overlay `View`** for “Opening creation tools…” and Composer (no `<Modal>` for the Composer) to avoid native modal stacking.
- **Consume media only when the tab is focused** (`useIsFocused`) so the Composer appears only after returning from camera/gallery/search.
- **Imperative sheet close** (`sheetRef.current?.close()`) when starting a source flow and when finishing (send/cancel) so the sheet doesn’t flicker or stay open.
- **No `setPhase('picker')` in the send/cancel path** — only close the sheet and call `onClose()`; reset phase when the modal is opened again.
- **Stable hook order** in CreationModal: all hooks at the top; visibility controlled by booleans and a single return tree so “Rendered fewer hooks” never happens.
- **ReflectionMediaContext** is the contract between the picker (camera/gallery/search) and the Composer: “pending media” is set by the source screen and consumed once by CreationModal when focused.

---

## Flow Diagram (User Actions → Components)

1. **User taps FAB** → Parent sets `creationModalVisible = true` → CreationModal mounts/shows, phase `'picker'`, bottom sheet opens.
2. **User taps Camera (or Gallery/Search)** → `beginSourceFlow('/camera')` → sheet closes, `router.push('/camera')` → full-screen camera route.
3. **User takes photo / picks media** → Source screen sets `pendingMedia` in ReflectionMediaContext, `router.back()` → back to tab.
4. **Tab gains focus** → CreationModal’s effect (guarded by `isFocused`) runs → `consumePendingMedia()` → local state updated, `phase = 'creating'`, full-screen overlay shows Composer.
5. **User sends or cancels** → `handleClose` or upload success handler → `sheetRef.current?.close()`, `onClose()` → parent sets `creationModalVisible = false` → overlay and sheet gone, header/tab bar back, user sees Timeline.
