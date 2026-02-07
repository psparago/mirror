#!/usr/bin/env node
/**
 * Cleanup orphaned response documents in Firestore and unreferenced selfie images in S3.
 *
 * Unreferenced Firestore responses: response docs whose reflection no longer exists or is deleted.
 * Orphaned S3 images: from/{eventId}/image.jpg where eventId is not a valid response_event_id
 * in any response doc that references an existing (non-deleted) reflection.
 *
 * Usage:
 *   node scripts/utilities/cleanup-orphaned-responses.js           # Dry run (preview only)
 *   node scripts/utilities/cleanup-orphaned-responses.js --execute # Actually delete
 *
 * Requires (from project root .env - dotenv loads when run from root):
 *   - AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 *   - GOOGLE_APPLICATION_CREDENTIALS (path to service account JSON), or
 *     FIREBASE_SERVICE_ACCOUNT_PATH, or serviceAccountKey.json in scripts/utilities/
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env'), override: true });
const AWS = require('aws-sdk');
const admin = require('firebase-admin');

// --- CONFIG ---
const BUCKET_NAME = 'reflections-1200b-storage';
const REFLECTIONS_COLLECTION = 'reflections';
const RESPONSES_COLLECTION = 'responses';
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'reflections-1200b';

const DRY_RUN = !process.argv.includes('--execute');

// --- SETUP ---
if (!process.env.AWS_ACCESS_KEY_ID) {
  console.error('❌ Missing AWS credentials. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.');
  process.exit(1);
}

if (!admin.apps.length) {
  try {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      admin.initializeApp({ projectId: PROJECT_ID });
    } else {
      const credPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
        path.join(__dirname, 'serviceAccountKey.json');
      const serviceAccount = require(credPath);
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
  } catch (e) {
    console.error('❌ Firebase credentials required. Set GOOGLE_APPLICATION_CREDENTIALS or');
    console.error('   FIREBASE_SERVICE_ACCOUNT_PATH, or place serviceAccountKey.json in scripts/utilities/');
    process.exit(1);
  }
}

const db = admin.firestore();
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: 'us-east-1',
});

async function getAllReflections() {
  const snap = await db.collection(REFLECTIONS_COLLECTION).get();
  const byId = {};
  snap.docs.forEach((doc) => {
    const d = doc.data();
    byId[doc.id] = {
      id: doc.id,
      status: d.status,
      explorerId: d.explorerId,
      hasAudioUrl: 'audio_url' in d,
      hasDeepDiveAudioUrl: 'deep_dive_audio_url' in d,
      ref: doc.ref,
    };
  });
  return byId;
}

async function getAllResponses() {
  const snap = await db.collection(RESPONSES_COLLECTION).get();
  return snap.docs.map((doc) => ({
    id: doc.id,
    explorerId: doc.data().explorerId,
    response_event_id: doc.data().response_event_id,
  }));
}

async function discoverExplorerPrefixes() {
  const data = await s3.listObjectsV2({
    Bucket: BUCKET_NAME,
    Delimiter: '/',
    MaxKeys: 1000,
  }).promise();
  return (data.CommonPrefixes || []).map((p) => p.Prefix.replace(/\/$/, '')).filter((p) => p && p !== 'staging');
}

async function listAllFromImages(explorerIds) {
  const keys = [];
  let prefixes = [...new Set(explorerIds)].filter(Boolean);
  if (prefixes.length === 0) {
    prefixes = await discoverExplorerPrefixes();
  }
  if (prefixes.length === 0) {
    prefixes = ['cole', 'peter'];
  }
  for (const explorerId of prefixes) {
    let token = null;
    do {
      const params = {
        Bucket: BUCKET_NAME,
        Prefix: `${explorerId}/from/`,
        ContinuationToken: token,
      };
      const data = await s3.listObjectsV2(params).promise();
      token = data.NextContinuationToken;
      (data.Contents || []).forEach((obj) => {
        if (obj.Key.endsWith('/image.jpg')) keys.push(obj.Key);
      });
    } while (token);
  }
  return keys;
}

async function run() {
  console.log(DRY_RUN ? '\n🔍 DRY RUN - no changes will be made\n' : '\n⚠️  EXECUTE MODE - will delete\n');

  const reflections = await getAllReflections();
  const responses = await getAllResponses();

  const validReflectionIds = new Set(
    Object.entries(reflections)
      .filter(([, r]) => r.status !== 'deleted')
      .map(([id]) => id)
  );

  const validS3Keys = new Set();
  const explorerIds = new Set();
  responses.forEach((r) => {
    if (r.explorerId) explorerIds.add(r.explorerId);
    if (!validReflectionIds.has(r.id)) return;
    const rid = r.response_event_id || r.id;
    if (!rid) return;
    const explorerId = r.explorerId || 'cole';
    validS3Keys.add(`${explorerId}/from/${rid}/image.jpg`);
  });
  Object.values(reflections).forEach((r) => {
    if (r.explorerId) explorerIds.add(r.explorerId);
  });

  const unreferencedResponses = responses.filter((r) => !validReflectionIds.has(r.id));
  console.log(`📋 Responses pointing to missing/deleted reflections: ${unreferencedResponses.length}`);

  const reflectionsToStripAudio = Object.values(reflections).filter(
    (r) => r.hasAudioUrl || r.hasDeepDiveAudioUrl
  );
  console.log(`📋 Reflections with audio_url/deep_dive_audio_url to strip: ${reflectionsToStripAudio.length}`);

  const s3Explorers = await discoverExplorerPrefixes();
  const allExplorerIds = [...new Set([...explorerIds, ...s3Explorers])];
  const allFromImages = await listAllFromImages(allExplorerIds);
  const orphanedS3 = allFromImages.filter((k) => !validS3Keys.has(k));
  console.log(`📋 Orphaned selfie images in S3 (from/): ${orphanedS3.length}`);

  if (unreferencedResponses.length === 0 && orphanedS3.length === 0 && reflectionsToStripAudio.length === 0) {
    console.log('\n✅ Nothing to clean up.');
    return;
  }

  if (reflectionsToStripAudio.length > 0) {
    console.log('\n🗑️  Stripping audio_url / deep_dive_audio_url from reflection docs:');
    reflectionsToStripAudio.slice(0, 10).forEach((r) => console.log(`   - ${r.id}`));
    if (reflectionsToStripAudio.length > 10) {
      console.log(`   ... and ${reflectionsToStripAudio.length - 10} more`);
    }
    if (!DRY_RUN) {
      const FieldValue = admin.firestore.FieldValue;
      const BATCH_SIZE = 500;
      for (let i = 0; i < reflectionsToStripAudio.length; i += BATCH_SIZE) {
        const batch = db.batch();
        reflectionsToStripAudio.slice(i, i + BATCH_SIZE).forEach((r) => {
          const update = {};
          if (r.hasAudioUrl) update.audio_url = FieldValue.delete();
          if (r.hasDeepDiveAudioUrl) update.deep_dive_audio_url = FieldValue.delete();
          batch.update(r.ref, update);
        });
        await batch.commit();
      }
      console.log(`   ✅ Stripped fields from ${reflectionsToStripAudio.length} reflection doc(s)`);
    }
  }

  if (unreferencedResponses.length > 0) {
    console.log('\n🗑️  Unreferenced Firestore response docs:');
    unreferencedResponses.forEach((r) => console.log(`   - ${r.id} (explorer: ${r.explorerId})`));
    if (!DRY_RUN) {
      const BATCH_SIZE = 500;
      for (let i = 0; i < unreferencedResponses.length; i += BATCH_SIZE) {
        const batch = db.batch();
        unreferencedResponses.slice(i, i + BATCH_SIZE).forEach((r) => {
          batch.delete(db.collection(RESPONSES_COLLECTION).doc(r.id));
        });
        await batch.commit();
      }
      console.log(`   ✅ Deleted ${unreferencedResponses.length} response doc(s)`);
    }
  }

  if (orphanedS3.length > 0) {
    console.log('\n🗑️  Orphaned S3 selfie images:');
    orphanedS3.slice(0, 20).forEach((k) => console.log(`   - ${k}`));
    if (orphanedS3.length > 20) console.log(`   ... and ${orphanedS3.length - 20} more`);
    if (!DRY_RUN) {
      let deleted = 0;
      for (const key of orphanedS3) {
        try {
          await s3.deleteObject({ Bucket: BUCKET_NAME, Key: key }).promise();
          deleted++;
          if (deleted % 10 === 0) process.stdout.write(`   Deleted ${deleted}/${orphanedS3.length}...\r`);
        } catch (e) {
          console.error(`\n   ❌ Failed to delete ${key}: ${e.message}`);
        }
      }
      console.log(`   ✅ Deleted ${deleted} S3 object(s)`);
    }
  }

  console.log('\n🎉 Done.');
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
