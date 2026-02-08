#!/usr/bin/env node
/**
 * Migrate V1 data (project-mirror-23168, mirror-uploads-sparago-2026) to V2
 * (reflections-1200b, reflections-1200b-storage).
 *
 * - Firestore: signals → reflections, reflection_responses → responses
 * - S3: cole/to/, cole/from/ → COLE-01052010/to/, COLE-01052010/from/
 *
 * Idempotent. Excludes orphan responses and deprecated fields (audio_url, deep_dive_audio_url).
 *
 * Usage:
 *   node scripts/utilities/migrate-v1-to-v2.js              # Dry run (default)
 *   node scripts/utilities/migrate-v1-to-v2.js --execute    # Actually migrate
 *
 * Requires: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY in .env
 * Service accounts: scripts/utilities/serviceAccountKey.json (V1), serviceAccountKeyV2.json (V2)
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env'), override: true });
const AWS = require('aws-sdk');
const admin = require('firebase-admin');

// --- CONFIG ---
const V1_S3_BUCKET = 'mirror-uploads-sparago-2026';
const V2_S3_BUCKET = 'reflections-1200b-storage';
const V1_S3_PREFIX = 'cole';
const V2_EXPLORER_ID = 'COLE-01052010';

const V1_REFLECTIONS_COLLECTION = 'reflections';
const V1_RESPONSES_COLLECTION = 'responses';
const V2_REFLECTIONS_COLLECTION = 'reflections';
const V2_RESPONSES_COLLECTION = 'responses';

const DEPRECATED_FIELDS = ['audio_url', 'deep_dive_audio_url'];

const DRY_RUN = !process.argv.includes('--execute');

const V1_CREDS_PATH = path.join(__dirname, 'serviceAccountKey.json');
const V2_CREDS_PATH = path.join(__dirname, 'serviceAccountKeyV2.json');

const fs = require('fs');
if (!fs.existsSync(V1_CREDS_PATH)) {
  console.error(`❌ V1 credentials not found: ${V1_CREDS_PATH}`);
  process.exit(1);
}
if (!fs.existsSync(V2_CREDS_PATH)) {
  console.error(`❌ V2 credentials not found: ${V2_CREDS_PATH}`);
  process.exit(1);
}

// --- SETUP ---
if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  console.error('❌ Missing AWS credentials. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env');
  process.exit(1);
}

// Initialize V1 Firebase (project-mirror-23168)
const v1Creds = require(V1_CREDS_PATH);
if (!admin.apps.find((a) => a.name === 'v1')) {
  admin.initializeApp(
    { credential: admin.credential.cert(v1Creds), projectId: v1Creds.project_id },
    'v1'
  );
}

// Initialize V2 Firebase (reflections-1200b)
const v2Creds = require(V2_CREDS_PATH);
if (!admin.apps.find((a) => a.name === 'v2')) {
  admin.initializeApp(
    { credential: admin.credential.cert(v2Creds), projectId: v2Creds.project_id },
    'v2'
  );
}

const dbV1 = admin.app('v1').firestore();
const dbV2 = admin.app('v2').firestore();
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: 'us-east-1',
});

function isColeDoc(data) {
  const eid = (data?.explorerId || '').toString();
  if (/^peter$/i.test(eid)) return false;
  return eid === 'cole' || eid === 'Cole' || eid === '';
}

function isPeterDoc(data) {
  const eid = (data?.explorerId || '').toString();
  return /^peter$/i.test(eid);
}

function stripDeprecated(obj) {
  const out = { ...obj };
  DEPRECATED_FIELDS.forEach((f) => delete out[f]);
  return out;
}

async function getAllV1Reflections() {
  const snap = await dbV1.collection(V1_REFLECTIONS_COLLECTION).get();
  const list = [];
  snap.docs.forEach((doc) => {
    const d = doc.data();
    if (!isColeDoc(d)) return;
    list.push({
      id: doc.id,
      data: d,
      status: d.status,
    });
  });
  return list;
}

async function getAllV1Responses() {
  const snap = await dbV1.collection(V1_RESPONSES_COLLECTION).get();
  const list = [];
  snap.docs.forEach((doc) => {
    const d = doc.data();
    if (isPeterDoc(d)) return;
    if (!isColeDoc(d)) return;
    list.push({
      id: doc.id,
      data: d,
    });
  });
  return list;
}

async function listS3Objects(bucket, prefix) {
  const keys = [];
  let token = null;
  do {
    const params = {
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: token,
    };
    const data = await s3.listObjectsV2(params).promise();
    token = data.NextContinuationToken;
    (data.Contents || []).forEach((obj) => {
      if (obj.Key && !obj.Key.endsWith('/')) keys.push(obj.Key);
    });
  } while (token);
  return keys;
}

async function run() {
  console.log(DRY_RUN ? '\n🔍 DRY RUN - no changes will be made\n' : '\n⚠️  EXECUTE MODE - migrating\n');

  // --- Firestore ---
  const reflections = await getAllV1Reflections();
  const responses = await getAllV1Responses();

  const reflectionMap = new Map(reflections.map((r) => [r.id, { status: r.status }]));
  const validReflectionIds = new Set(
    reflections.filter((r) => r.status !== 'deleted').map((r) => r.id)
  );

  const reflectionsToMigrate = reflections.filter((r) => r.status !== 'deleted');
  const orphansMissing = responses.filter((r) => !reflectionMap.has(r.id));
  const orphansDeleted = responses.filter((r) => reflectionMap.has(r.id) && reflectionMap.get(r.id).status === 'deleted');
  const responsesToMigrate = responses.filter((r) => validReflectionIds.has(r.id));
  const orphanCount = orphansMissing.length + orphansDeleted.length;

  console.log(`📋 V1 Firestore: ${reflections.length} reflections (cole), ${responses.length} responses (cole; peter excluded)`);
  console.log(`   Reflections to migrate: ${reflectionsToMigrate.length}`);
  console.log(`   Responses to migrate: ${responsesToMigrate.length}`);
  console.log(`   Orphans excluded: ${orphanCount} (${orphansMissing.length} reflection missing, ${orphansDeleted.length} reflection deleted)`);

  // --- S3 ---
  const toKeys = await listS3Objects(V1_S3_BUCKET, `${V1_S3_PREFIX}/to/`);
  const fromKeys = await listS3Objects(V1_S3_BUCKET, `${V1_S3_PREFIX}/from/`);
  const s3KeysToCopy = [...toKeys, ...fromKeys];
  console.log(`📋 V1 S3: ${toKeys.length} objects in cole/to/, ${fromKeys.length} in cole/from/`);

  if (reflectionsToMigrate.length === 0 && responsesToMigrate.length === 0 && s3KeysToCopy.length === 0) {
    console.log('\n✅ Nothing to migrate.');
    return;
  }

  if (DRY_RUN) {
    console.log('\n--- Would migrate ---');
    reflectionsToMigrate.slice(0, 5).forEach((r) => console.log(`   reflection: ${r.id}`));
    if (reflectionsToMigrate.length > 5) console.log(`   ... and ${reflectionsToMigrate.length - 5} more`);
    responsesToMigrate.slice(0, 5).forEach((r) => console.log(`   response: ${r.id}`));
    if (responsesToMigrate.length > 5) console.log(`   ... and ${responsesToMigrate.length - 5} more`);
    s3KeysToCopy.slice(0, 10).forEach((k) => console.log(`   S3: ${k} -> ${k.replace(V1_S3_PREFIX, V2_EXPLORER_ID)}`));
    if (s3KeysToCopy.length > 10) console.log(`   ... and ${s3KeysToCopy.length - 10} more`);
    console.log('\n🎉 Dry run complete. Use --execute to perform migration.');
    return;
  }

  let reflectionsMigrated = 0;
  let reflectionsSkipped = 0;
  let reflectionsErrors = 0;
  let responsesMigrated = 0;
  let responsesSkipped = 0;
  let responsesErrors = 0;
  let s3Migrated = 0;
  let s3Errors = 0;

  // Firestore: reflections
  const BATCH_SIZE = 500;
  for (let i = 0; i < reflectionsToMigrate.length; i += BATCH_SIZE) {
    const chunk = reflectionsToMigrate.slice(i, i + BATCH_SIZE);
    const batch = dbV2.batch();
    let batchCount = 0;
    for (const r of chunk) {
      const ref = dbV2.collection(V2_REFLECTIONS_COLLECTION).doc(r.id);
      try {
        const existing = await ref.get();
        if (existing.exists) {
          reflectionsSkipped++;
          continue;
        }
        const data = stripDeprecated({
          ...r.data,
          explorerId: V2_EXPLORER_ID,
          event_id: r.data.event_id || r.id,
        });
        batch.set(ref, data);
        batchCount++;
        reflectionsMigrated++;
      } catch (e) {
        console.error(`   ❌ reflection ${r.id}: ${e.message}`);
        reflectionsErrors++;
      }
    }
    if (batchCount > 0) {
      try {
        await batch.commit();
      } catch (e) {
        console.error(`   ❌ reflections batch commit: ${e.message}`);
        reflectionsErrors += batchCount;
      }
    }
  }
  console.log(`\n✅ Reflections: migrated ${reflectionsMigrated}, skipped (exists) ${reflectionsSkipped}, errors ${reflectionsErrors}`);

  // Firestore: responses
  for (let i = 0; i < responsesToMigrate.length; i += BATCH_SIZE) {
    const chunk = responsesToMigrate.slice(i, i + BATCH_SIZE);
    const batch = dbV2.batch();
    let batchCount = 0;
    for (const r of chunk) {
      const ref = dbV2.collection(V2_RESPONSES_COLLECTION).doc(r.id);
      try {
        const existing = await ref.get();
        if (existing.exists) {
          responsesSkipped++;
          continue;
        }
        const data = {
          ...r.data,
          explorerId: V2_EXPLORER_ID,
        };
        batch.set(ref, data);
        batchCount++;
        responsesMigrated++;
      } catch (e) {
        console.error(`   ❌ response ${r.id}: ${e.message}`);
        responsesErrors++;
      }
    }
    if (batchCount > 0) {
      try {
        await batch.commit();
      } catch (e) {
        console.error(`   ❌ responses batch commit: ${e.message}`);
        responsesErrors += batchCount;
      }
    }
  }
  console.log(`✅ Responses: migrated ${responsesMigrated}, skipped (exists) ${responsesSkipped}, errors ${responsesErrors}`);

  // S3: copy objects
  for (let j = 0; j < s3KeysToCopy.length; j++) {
    const srcKey = s3KeysToCopy[j];
    const destKey = srcKey.replace(V1_S3_PREFIX, V2_EXPLORER_ID);
    try {
      await s3.copyObject({
        Bucket: V2_S3_BUCKET,
        CopySource: `${V1_S3_BUCKET}/${srcKey}`,
        Key: destKey,
      }).promise();
      s3Migrated++;
      if (s3Migrated % 20 === 0) process.stdout.write(`   S3: ${s3Migrated}/${s3KeysToCopy.length}...\r`);
    } catch (e) {
      console.error(`\n   ❌ S3 ${srcKey}: ${e.message}`);
      s3Errors++;
    }
  }
  console.log(`\n✅ S3: migrated ${s3Migrated}, errors ${s3Errors}`);

  console.log('\n🎉 Migration complete.');
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
