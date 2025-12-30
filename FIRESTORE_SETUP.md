# Firestore Database Setup Guide

## Step 1: Create Firestore Database

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project: **project-mirror-23168**
3. In the left sidebar, click **Firestore Database**
4. Click **Create database**
5. Choose **Start in test mode** (for now - we'll add security rules later)
6. Select a location (choose closest to you, e.g., `us-central` or `us-east1`)
7. Click **Enable**

## Step 2: Set Up Security Rules (Important!)

After creating the database, go to **Rules** tab and use these rules:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Allow read/write access to signals collection
    match /signals/{signalId} {
      allow read, write: if true; // For testing - will secure later
    }
  }
}
```

Click **Publish** to save the rules.

## Step 3: Verify Collection Structure

The app will automatically create the `signals` collection when you send your first photo. Each document will have:
- Document ID: `event_id` (timestamp)
- Fields:
  - `event_id`: string
  - `sender`: "Granddad"
  - `status`: "ready"
  - `timestamp`: serverTimestamp
  - `type`: "mirror_event"

## Troubleshooting

If you see errors:
- **Permission denied**: Check security rules are published
- **Database not found**: Make sure you created the database in the correct project
- **Network error**: Check your internet connection

## Next Steps (After Testing)

Once everything works, update security rules to be more restrictive:
- Only allow writes from authenticated users
- Only allow reads for specific users
- Add validation for document structure

