# Migration: Looking Glass → Reflections

Checklist for migrating both apps to the new **Reflections** branding, bundle IDs, Expo projects, Sentry projects, and Apple apps.

---

## 1. In-Repo Configuration

### 1.1 Explorer (`apps/explorer`)

| Location | Property | Current | Action |
|----------|----------|---------|--------|
| **app.json** | `expo.slug` | `reflections` | Align with app.config: use `reflections-explorer` (or keep `reflections` if Expo project is already created with it). |
| **app.json** | `expo.scheme` | `reflections-explorer` | ✓ OK |
| **app.json** | `expo.ios.bundleIdentifier` | `com.psparago.reflections.explorer` | ✓ OK |
| **app.json** | `expo.android.package` | `com.psparago.reflections.explorer` | ✓ OK |
| **app.json** | `extra.eas.projectId` | `b31ff8bd-3c85-4fc4-a7a7-9da9453ac9ec` | Must match your **new** EAS project for Explorer. |
| **app.json** | `updates.url` | `https://u.expo.dev/c68c385b-fb1c-4beb-b226-5750b49b20d2` | **Must use same ID as `extra.eas.projectId`** → e.g. `https://u.expo.dev/b31ff8bd-3c85-4fc4-a7a7-9da9453ac9ec` |
| **app.config.ts** | `name` | `Explorer` / `Explorer Dev` | ✓ OK (or rename to "Reflections Explorer" if desired). |
| **app.config.ts** | `slug` | `reflection-explorer` | Align with app.json `slug` (e.g. `reflections-explorer`). |
| **app.config.ts** | `ios.bundleIdentifier` | `com.psparago.reflections.explorer` (dev: `.dev`) | ✓ OK |
| **app.config.ts** | `ios.infoPlist.CFBundleURLSchemes` | Google client ID for 759023712124 | Must match **GoogleService-Info.plist** / Google Cloud OAuth client for Explorer. |
| **eas.json** | `submit.production.ios.ascAppId` | `6757921983` | Replace with **new** App Store Connect app ID for Reflections Explorer. |
| **eas.json** | `submit.production.ios.appleId` | `peter.sparago@gmail.com` | ✓ OK (or update if using a different Apple ID). |

### 1.2 Connect (`apps/connect`)

| Location | Property | Current | Action |
|----------|----------|---------|--------|
| **app.json** | `expo.slug` | `reflections-connect` | ✓ OK |
| **app.json** | `expo.scheme` | `reflections-connect` | ✓ OK |
| **app.json** | `expo.ios.bundleIdentifier` | `com.psparago.reflections.connect` | ✓ OK |
| **app.json** | `expo.android.package` | `com.psparago.reflections.connect` | ✓ OK |
| **app.json** | `extra.eas.projectId` | `a21eb601-52c9-4d66-97d9-0891967bedee` | Must match your **new** EAS project for Connect. |
| **app.json** | `updates.url` | `https://u.expo.dev/a21eb601-52c9-4d66-97d9-0891967bedee` | Must match `extra.eas.projectId` ✓ |
| **app.config.ts** | `name` | `Connect` / `Connect Dev` | ✓ OK (or "Reflections Connect"). |
| **app.config.ts** | `ios.infoPlist.CFBundleURLSchemes` | Google client ID for 759023712124 | Must match Connect **GoogleService-Info.plist** / OAuth client. |
| **eas.json** | `submit.production.ios.ascAppId` | `6757921651` | Replace with **new** App Store Connect app ID for Reflections Connect. |

### 1.3 Root `app.json`

| Property | Current | Action |
|----------|---------|--------|
| `extra.eas.projectId` | `b31ff8bd-3c85-4fc4-a7a7-9da9453ac9ec` | Usually same as Explorer EAS project. |
| `updates.url` | `https://u.expo.dev/76b4c297-74fd-4954-9716-d51461bdd7cf` | **Must use same project ID as `extra.eas.projectId`** → e.g. `https://u.expo.dev/b31ff8bd-3c85-4fc4-a7a7-9da9453ac9ec`. |
| `ios.bundleIdentifier` | `com.psparago.projectmirrormonorepo` | Update if you use this for a root/placeholder app. |

---

## 2. Sentry

- **Plugin** (already set): `@sentry/react-native` with `organization: "angelwareorg"` and `project: "reflections-explorer"` / `"reflections-connect"`.
- **DSN in code** (you must update after creating new Sentry projects):
  - **Explorer**: `apps/explorer/app/_layout.tsx` — replace `dsn: 'https://5510fbc509b29cd3d26ed552dc09ed83@...'` with the DSN from your **new** Sentry project (e.g. "reflections-explorer").
  - **Connect**: `apps/connect/app/_layout.tsx` — replace `dsn: 'https://fd5be68ebbed311e8537030781ed02fb@...'` with the DSN from your **new** Sentry project (e.g. "reflections-connect").
- In **Sentry**: Create two new projects (e.g. "reflections-explorer", "reflections-connect"), then copy each project’s DSN into the corresponding `_layout.tsx`.

---

## 3. Firebase / Google (Auth & Backend)

- **GoogleService-Info.plist** (Explorer & Connect): You said these are already configured for the new bundle IDs and Firebase project ✓.
- **AuthContext** (`packages/shared/src/auth/AuthContext.tsx`):
  - **Dev app check**: `isDevApp = Application.applicationId === 'com.psparago.lookingglass.companion.dev'` → change to `'com.psparago.reflections.connect.dev'`.
  - If you are **moving auth to the new Firebase project** (e.g. `reflections-1200b`):
    - Update `firebaseConfig` (e.g. `projectId`, `apiKey`, `storageBucket`, `authDomain`, `databaseURL`, `messagingSenderId`).
    - Update `PROD_APP_ID` / `DEV_APP_ID` to the iOS app IDs from the **new** Firebase project (from the new plists or Firebase Console).
    - Update `GOOGLE_WEB_CLIENT_ID` to the new OAuth 2.0 Web client from the new Google Cloud project.
  - If you are **keeping the existing Firebase project** (project-mirror-23168) for backend, leave `firebaseConfig` and app IDs as-is; only fix `isDevApp` to the new Connect dev bundle ID.
- **app.config.ts** (both apps): `CFBundleURLSchemes` must be the **reversed client ID** of the iOS OAuth client that matches the bundle ID (from GoogleService-Info or Firebase Console). Your current value uses `759023712124-...`; ensure that client is for the correct bundle ID in the new project.

---

## 4. Apple Developer Portal

Create or update the following so they match your new bundle IDs and EAS/Expo setup.

### 4.1 App IDs (Identifiers)

| App | Production | Development |
|-----|------------|-------------|
| **Explorer** | `com.psparago.reflections.explorer` | `com.psparago.reflections.explorer.dev` |
| **Connect** | `com.psparago.reflections.connect` | `com.psparago.reflections.connect.dev` |

- For each: enable only the capabilities you use (Sign in with Apple, Push Notifications, Associated Domains, etc.).
- Ensure the **Team ID** and **Signing Certificate** are correct for your account.

### 4.2 Provisioning Profiles

- **Development**: One per bundle ID (e.g. Explorer, Explorer Dev, Connect, Connect Dev), with the devices you use for dev builds.
- **Distribution (App Store)**: One per **production** bundle ID (`com.psparago.reflections.explorer`, `com.psparago.reflections.connect`).
- **Ad Hoc** (if you use internal distribution): One per bundle ID you use for preview/internal builds.
- EAS Build will create or use profiles that match the bundle ID in **app.config.ts**; ensure those bundle IDs exist as App IDs and that the right certificates are in the team.

### 4.3 Certificates

- **Apple Distribution** (and **Apple Development** for dev builds) for the account that builds and submits.
- If you use a different Apple ID for submission, ensure that account has the right role in App Store Connect and that the distribution certificate is valid.

---

## 5. App Store Connect

- **New apps** (if you created new app records for Reflections):
  - Create an app for **Reflections Explorer** (bundle ID `com.psparago.reflections.explorer`).
  - Create an app for **Reflections Connect** (bundle ID `com.psparago.reflections.connect`).
  - For each, open **App Information** and copy the **Apple ID** (numeric) → put it in the corresponding **eas.json** under `submit.production.ios.ascAppId`.
- **Export compliance**: You already set `ITSAppUsesNonExemptEncryption: false` in app.json; keep it for the new apps if they don’t use custom crypto.
- **TestFlight**: After the first EAS production build and auto-submit, builds will show under these new app records.

---

## 6. EAS / Expo Dashboard

- **Projects**: Ensure you have two EAS projects (e.g. “Reflections Explorer” and “Reflections Connect”) and that:
  - **Explorer** `app.json` `extra.eas.projectId` and `updates.url` use the **Explorer** EAS project ID.
  - **Connect** `app.json` `extra.eas.projectId` and `updates.url` use the **Connect** EAS project ID.
- **Credentials**: In EAS, link the correct Apple Team and let EAS manage provisioning profiles, or use your own; ensure the bundle IDs in **app.config.ts** match the App IDs in the Apple Developer Portal.
- **Channels**: After migration, OTA updates (`eas update`) use the branch/channel for the project tied to that app’s `projectId` and `updates.url`.

---

## 7. Docs & Scripts (Optional but Recommended)

Update any remaining “Looking Glass” references to “Reflections” for consistency:

| File | Notes |
|------|--------|
| `.cursorrules` | Already describes Reflections Explorer / Connect; “Looking Glass” only in “DO NOT USE” and “Formerly known as”. |
| `packages/shared/src/auth/AuthContext.tsx` | Update `isDevApp` bundle ID (see §3). |
| `packages/shared/src/machines/playerMachine.ts` | Internal ID `lookingGlassPlayer`; optional rename to e.g. `reflectionsPlayer`. |
| `scripts/run-explorer.sh` | Comment says “Looking Glass (LG)” — can change to “Reflections Explorer”. |
| `scripts/run-connect.sh` | Comment says “Looking Glass Companion” — can change to “Reflections Connect”. |
| `scripts/eas/README.md` | Replace “Looking Glass” with “Reflections” and update bundle IDs/slugs. |
| `scripts/eas/build-all-preview-ios.sh` | Echo text “Looking Glass” → “Reflections”. |
| `scripts/build/build-local.sh` | Echo text “Looking Glass” → “Reflections Explorer”. |
| `.agent/ROADMAP.md`, `RELEASE_MANUAL.md`, `REFACTORING_NOTES.md` | Replace “Looking Glass” with “Reflections” where appropriate. |

---

## 8. Quick Fix: Explorer `updates.url` Mismatch

In **apps/explorer/app.json**, `extra.eas.projectId` is `b31ff8bd-3c85-4fc4-a7a7-9da9453ac9ec` but `updates.url` uses `c68c385b-fb1c-4beb-b226-5750b49b20d2`. OTA updates will fail for the wrong project. Set:

```json
"updates": {
  "url": "https://u.expo.dev/b31ff8bd-3c85-4fc4-a7a7-9da9453ac9ec"
}
```

(Use the same UUID as `extra.eas.projectId` for the Explorer EAS project.)

---

## Summary Table: What You Must Set Outside the Repo

| Where | What to do |
|-------|------------|
| **Expo dashboard** | Confirm two EAS projects; note their project IDs and set `extra.eas.projectId` + `updates.url` in each app’s app.json. |
| **Sentry** | Create “reflections-explorer” and “reflections-connect”; copy DSNs into `apps/explorer/app/_layout.tsx` and `apps/connect/app/_layout.tsx`. |
| **Apple Developer** | Create App IDs and provisioning profiles for `com.psparago.reflections.explorer`, `.explorer.dev`, `.connect`, `.connect.dev`. |
| **App Store Connect** | Create (or use) app records for Reflections Explorer and Reflections Connect; put each app’s numeric Apple ID in the corresponding `eas.json` under `submit.production.ios.ascAppId`. |
| **Firebase / Google** | If using a new Firebase project, update AuthContext (and optional shared firebase config) and ensure OAuth client IDs and plists match; in all cases update `isDevApp` to `com.psparago.reflections.connect.dev`. |

After these, run a production EAS build for each app and submit to TestFlight to verify profiles and App Store Connect linkage.
