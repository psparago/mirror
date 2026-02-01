# 🚀 Release & Update Operations Manual

This guide covers how to push updates to **Looking Glass (Cole)** and **Companion**.

---

## ⚡️ Option A: Over-the-Air (OTA) Update
**Use this when:** You only changed JavaScript/TypeScript code (UI, logic, API calls).
**Do NOT use this when:** You added new npm packages that require native linking (like `expo-camera`) or changed `app.json` / `Info.plist`.

### 1. The Command
You do **not** need to bump the version number in `app.json` for this.

#### For Looking Glass (Cole)
```bash
cd apps/explorer
npx eas update --channel production --message "Fix: Dynamic user for selfies"