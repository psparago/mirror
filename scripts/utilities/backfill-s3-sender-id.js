#!/usr/bin/env node
/**
 * Backfill sender_id into S3 metadata.json files.
 *
 * Reads sender_id from Firestore reflection docs (already backfilled there)
 * and patches the corresponding S3 metadata.json so the Explorer app can
 * filter by companion without a separate Firestore query.
 *
 * Usage:
 *   node scripts/utilities/backfill-s3-sender-id.js                          # Dry run, all explorers
 *   node scripts/utilities/backfill-s3-sender-id.js --explorer COLE-01052010  # Dry run, one explorer
 *   node scripts/utilities/backfill-s3-sender-id.js --execute                 # Write changes
 *
 * Requires (from project root .env):
 *   - AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 *   - GOOGLE_APPLICATION_CREDENTIALS or serviceAccountKeyV2.json in scripts/utilities/
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env'), override: true });
const AWS = require('aws-sdk');
const admin = require('firebase-admin');

const BUCKET = 'reflections-1200b-storage';
const REFLECTIONS_COLLECTION = 'reflections';

const DRY_RUN = !process.argv.includes('--execute');
const explorerArg = (() => {
  const idx = process.argv.indexOf('--explorer');
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
})();

if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  console.error('❌ Missing AWS credentials. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env');
  process.exit(1);
}

if (!admin.apps.length) {
  try {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      admin.initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT || 'reflections-1200b' });
    } else {
      const credPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
        path.join(__dirname, 'serviceAccountKeyV2.json');
      const serviceAccount = require(credPath);
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
  } catch (e) {
    console.error('❌ Firebase credentials required. Set GOOGLE_APPLICATION_CREDENTIALS or');
    console.error('   place serviceAccountKeyV2.json in scripts/utilities/');
    process.exit(1);
  }
}

const db = admin.firestore();
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: 'us-east-1',
});

async function run() {
  console.log(DRY_RUN ? '\n🔍 DRY RUN — no S3 writes\n' : '\n⚠️  EXECUTE MODE — will overwrite S3 metadata.json files\n');
  if (explorerArg) console.log(`   Filtering to explorer: ${explorerArg}\n`);

  // 1. Load all reflections that have sender_id from Firestore
  const snap = await db.collection(REFLECTIONS_COLLECTION).get();
  const docs = [];
  snap.docs.forEach((doc) => {
    const d = doc.data();
    if (!d.sender_id) return;
    if (!d.explorerId) return;
    if (explorerArg && d.explorerId !== explorerArg) return;
    docs.push({
      id: doc.id,
      explorerId: d.explorerId,
      senderId: d.sender_id,
      eventId: d.event_id || doc.id,
    });
  });

  console.log(`📋 Firestore: ${snap.size} total reflections, ${docs.length} with sender_id to process\n`);
  if (docs.length === 0) {
    console.log('✅ Nothing to backfill.');
    return;
  }

  let patched = 0;
  let alreadySet = 0;
  let missing = 0;
  let errors = 0;

  for (let i = 0; i < docs.length; i++) {
    const { id, explorerId, senderId, eventId } = docs[i];
    const key = `${explorerId}/to/${eventId}/metadata.json`;

    try {
      const obj = await s3.getObject({ Bucket: BUCKET, Key: key }).promise();
      const meta = JSON.parse(obj.Body.toString('utf-8'));

      if (meta.sender_id === senderId) {
        alreadySet++;
        continue;
      }

      meta.sender_id = senderId;

      if (!DRY_RUN) {
        await s3.putObject({
          Bucket: BUCKET,
          Key: key,
          Body: JSON.stringify(meta),
          ContentType: 'application/json',
        }).promise();
      }
      patched++;
    } catch (err) {
      if (err.code === 'NoSuchKey') {
        missing++;
        if (missing <= 5) console.log(`   ⚠️  No metadata.json: ${key}`);
      } else {
        errors++;
        if (errors <= 5) console.error(`   ❌ ${key}: ${err.message}`);
      }
    }

    if ((i + 1) % 50 === 0 || i === docs.length - 1) {
      process.stdout.write(`   Progress: ${i + 1}/${docs.length} (patched=${patched}, exists=${alreadySet}, missing=${missing}, errors=${errors})\r`);
    }
  }

  console.log(`\n\n📊 Results:`);
  console.log(`   Patched:      ${patched}${DRY_RUN ? ' (would patch)' : ''}`);
  console.log(`   Already set:  ${alreadySet}`);
  console.log(`   No S3 file:   ${missing}`);
  console.log(`   Errors:       ${errors}`);
  console.log(DRY_RUN ? '\n🎉 Dry run complete. Use --execute to write changes.' : '\n🎉 Backfill complete.');
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
