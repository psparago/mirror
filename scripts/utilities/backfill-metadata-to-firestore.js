#!/usr/bin/env node
/**
 * Backfill Firestore `reflections` documents with `metadata` parsed from S3 `metadata.json`.
 *
 * Skips documents that already have a non-empty `metadata` object (does not overwrite).
 *
 * Reading metadata.json:
 *   - Default (`--source s3`, recommended): GET object at
 *       {explorerId}/to/{event_id}/metadata.json
 *     using AWS SDK (same layout as backfill-s3-sender-id.js). Works for all legacy rows
 *     even when Firestore has no `metadata_url` or only an expired presigned URL.
 *   - Optional (`--source url`): HTTP GET the document's `metadata_url` field only.
 *     Skips docs with no `metadata_url`. URLs may be expired.
 *
 * Writes use Firestore batched commits (450 ops per batch) with a short pause between batches.
 *
 * Usage (from repo root, after `npm install`):
 *   node scripts/utilities/backfill-metadata-to-firestore.js                    # dry run, all explorers
 *   node scripts/utilities/backfill-metadata-to-firestore.js --explorer EXP_ID # dry run, one explorer
 *   node scripts/utilities/backfill-metadata-to-firestore.js --execute          # apply writes
 *   node scripts/utilities/backfill-metadata-to-firestore.js --execute --source url
 *
 * Requires (from project root .env or env):
 *   - AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (for --source s3, default)
 *   - GOOGLE_APPLICATION_CREDENTIALS or scripts/utilities/serviceAccountKeyV2.json
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env'), override: true });
const AWS = require('aws-sdk');
const admin = require('firebase-admin');

const BUCKET = 'reflections-1200b-storage';
const REFLECTIONS_COLLECTION = 'reflections';
const BATCH_SIZE = 450;
const PAUSE_MS_BETWEEN_BATCHES = 250;

const DRY_RUN = !process.argv.includes('--execute');
const SOURCE_URL = process.argv.includes('--source') && process.argv[process.argv.indexOf('--source') + 1] === 'url';

const explorerArg = (() => {
  const idx = process.argv.indexOf('--explorer');
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
})();

if (!SOURCE_URL && (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY)) {
  console.error('❌ Missing AWS credentials. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env');
  console.error('   (Or run with --source url to fetch metadata_url via HTTP only — no AWS keys.)');
  process.exit(1);
}

if (!admin.apps.length) {
  try {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      admin.initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT || 'reflections-1200b' });
    } else {
      const credPath =
        process.env.FIREBASE_SERVICE_ACCOUNT_PATH || path.join(__dirname, 'serviceAccountKeyV2.json');
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
const s3 =
  !SOURCE_URL &&
  new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: 'us-east-1',
  });

/** Skip if Firestore already has meaningful metadata (do not overwrite). */
function hasExistingMetadata(data) {
  const m = data.metadata;
  if (m == null) return false;
  if (typeof m !== 'object' || Array.isArray(m)) return true;
  return Object.keys(m).length > 0;
}

/** Coerce parsed JSON toward EventMetadata shape (strings; strip unknown). */
function normalizeEventMetadata(raw, fallbackEventId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const description =
    typeof raw.description === 'string' ? raw.description : typeof raw.short_caption === 'string' ? raw.short_caption : '';
  const sender = typeof raw.sender === 'string' ? raw.sender : '';
  if (!description && !sender) return null;

  let timestamp;
  const ts = raw.timestamp;
  if (typeof ts === 'string') {
    timestamp = ts;
  } else if (ts && typeof ts === 'object' && typeof ts.toDate === 'function') {
    timestamp = ts.toDate().toISOString();
  } else if (ts && typeof ts === 'object' && typeof ts._seconds === 'number') {
    timestamp = new Date(ts._seconds * 1000).toISOString();
  } else {
    timestamp = new Date().toISOString();
  }

  const event_id =
    typeof raw.event_id === 'string' && raw.event_id.length > 0 ? raw.event_id : fallbackEventId;

  const out = {
    description: description || 'Reflection',
    sender: sender || 'Companion',
    timestamp,
    event_id,
  };

  if (typeof raw.sender_id === 'string' && raw.sender_id) out.sender_id = raw.sender_id;
  if (raw.content_type === 'text' || raw.content_type === 'audio' || raw.content_type === 'video') {
    out.content_type = raw.content_type;
  }
  if (raw.image_source === 'camera' || raw.image_source === 'search') {
    out.image_source = raw.image_source;
  }
  if (typeof raw.short_caption === 'string' && raw.short_caption) out.short_caption = raw.short_caption;
  if (typeof raw.deep_dive === 'string' && raw.deep_dive) out.deep_dive = raw.deep_dive;
  if (typeof raw.deep_dive_audio_url === 'string' && raw.deep_dive_audio_url) {
    out.deep_dive_audio_url = raw.deep_dive_audio_url;
  }

  return out;
}

async function fetchMetadataJsonFromS3(explorerId, eventId) {
  const key = `${explorerId}/to/${eventId}/metadata.json`;
  const obj = await s3.getObject({ Bucket: BUCKET, Key: key }).promise();
  return JSON.parse(obj.Body.toString('utf-8'));
}

async function fetchMetadataJsonFromUrl(url) {
  const res = await fetch(url, { method: 'GET' });
  if (res.status === 404) {
    const err = new Error('HTTP 404');
    err.code = 'NotFound';
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.code = 'HttpError';
    throw err;
  }
  const text = await res.text();
  return JSON.parse(text);
}

async function run() {
  console.log(DRY_RUN ? '\n🔍 DRY RUN — no Firestore writes\n' : '\n⚠️  EXECUTE MODE — will write `metadata` to Firestore\n');
  console.log(`   Read source: ${SOURCE_URL ? 'HTTP metadata_url' : 'S3 metadata.json'}\n`);
  if (explorerArg) console.log(`   Filtering to explorerId: ${explorerArg}\n`);

  const snap = await db.collection(REFLECTIONS_COLLECTION).get();
  const candidates = snap.docs.filter((doc) => {
    const d = doc.data();
    if (hasExistingMetadata(d)) return false;
    if (explorerArg && d.explorerId !== explorerArg) return false;
    const eventId = d.event_id || doc.id;
    if (!d.explorerId || !eventId) return false;
    if (SOURCE_URL && !d.metadata_url) return false;
    return true;
  });

  const skippedHasMetadata = snap.docs.filter((d) => hasExistingMetadata(d.data())).length;
  const skippedExplorer = explorerArg ? snap.docs.filter((d) => d.data().explorerId !== explorerArg).length : 0;

  console.log(`📋 Firestore: ${snap.size} documents in "${REFLECTIONS_COLLECTION}"`);
  console.log(`   Candidates (missing metadata, have explorerId+event): ${candidates.length}`);
  console.log(`   Skipped (already had metadata): ${skippedHasMetadata}`);
  if (explorerArg) console.log(`   Skipped (other explorer): ${skippedExplorer}\n`);
  else console.log('');

  if (candidates.length === 0) {
    console.log('✅ Nothing to backfill.');
    return;
  }

  let migrated = 0;
  let failed = 0;
  let skippedRead = 0;

  let batch = db.batch();
  let opsInBatch = 0;

  async function flushBatch() {
    if (opsInBatch === 0) return;
    if (!DRY_RUN) {
      await batch.commit();
      await new Promise((r) => setTimeout(r, PAUSE_MS_BETWEEN_BATCHES));
    }
    batch = db.batch();
    opsInBatch = 0;
  }

  for (let i = 0; i < candidates.length; i++) {
    const doc = candidates[i];
    const d = doc.data();
    const eventId = d.event_id || doc.id;
    const explorerId = d.explorerId;

    let raw;
    try {
      if (SOURCE_URL) {
        raw = await fetchMetadataJsonFromUrl(d.metadata_url);
      } else {
        raw = await fetchMetadataJsonFromS3(explorerId, eventId);
      }
    } catch (err) {
      failed++;
      if (err.code === 'NoSuchKey' || err.code === 'NotFound') skippedRead++;
      if (failed <= 15) {
        console.error(`   ❌ Failed [${doc.id}]: ${err.message || err}`);
      }
      continue;
    }

    let normalized;
    try {
      normalized = normalizeEventMetadata(raw, eventId);
    } catch (err) {
      failed++;
      if (failed <= 15) console.error(`   ❌ Bad JSON / normalize [${doc.id}]: ${err.message || err}`);
      continue;
    }

    if (!normalized) {
      failed++;
      if (failed <= 15) console.error(`   ❌ Failed [${doc.id}]: normalized metadata empty after parse`);
      continue;
    }

    const ref = doc.ref;
    if (!DRY_RUN) {
      batch.set(ref, { metadata: normalized }, { merge: true });
      opsInBatch++;
      if (opsInBatch >= BATCH_SIZE) {
        await flushBatch();
      }
    }

    migrated++;
    if (migrated <= 20 || migrated % 100 === 0) {
      console.log(`   ✅ Migrated [${doc.id}]${DRY_RUN ? ' (dry run)' : ''}`);
    }

    if ((i + 1) % 50 === 0 || i === candidates.length - 1) {
      process.stdout.write(
        `   Progress: ${i + 1}/${candidates.length} (migrated=${migrated}, failed=${failed})\r`
      );
    }
  }

  await flushBatch();

  console.log('\n\n📊 Summary');
  console.log(`   Total candidates: ${candidates.length}`);
  console.log(`   Total migrated:   ${migrated}${DRY_RUN ? ' (would write)' : ''}`);
  console.log(`   Total failed:     ${failed}`);
  if (skippedRead) console.log(`   (includes ${skippedRead} missing S3/HTTP object)`);
  console.log(DRY_RUN ? '\n🎉 Dry run complete. Use --execute to write changes.' : '\n🎉 Backfill complete.');
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
