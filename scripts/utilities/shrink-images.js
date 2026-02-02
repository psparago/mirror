require('dotenv').config();
const AWS = require('aws-sdk');
const sharp = require('sharp');

// --- CONFIG ---
const BUCKET_NAME = 'reflections-1200b-storage'; 
const TARGET_WIDTH = 1080;
const QUALITY = 80;
const SIZE_THRESHOLD_KB = 600; // Only shrink if bigger than this

// The folders you identified
const PREFIXES = [
  'cole/to/',
  'cole/from/',
  'peter/to/',
  'peter/from/'
];

// --- SETUP ---
if (!process.env.AWS_ACCESS_KEY_ID) {
    console.error("❌ Missing AWS Credentials.");
    process.exit(1);
}

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: 'us-east-1' // <--- VERIFY REGION
});

async function processPrefix(prefix) {
    console.log(`\n📂 Scanning folder: ${prefix}...`);
    
    let token = null;
    do {
        // List all files in this folder
        const listParams = {
            Bucket: BUCKET_NAME,
            Prefix: prefix,
            ContinuationToken: token
        };
        
        const data = await s3.listObjectsV2(listParams).promise();
        token = data.NextContinuationToken;

        for (const obj of data.Contents) {
            // Filter: Must be .jpg and NOT a backup we just made
            if (!obj.Key.endsWith('.jpg') || obj.Key.includes('_original.jpg')) continue;

            const sizeKB = obj.Size / 1024;
            
            // Skip small files
            if (sizeKB < SIZE_THRESHOLD_KB) {
                // console.log(`   Skipping ${obj.Key} (${sizeKB.toFixed(0)}KB)`);
                continue;
            }

            console.log(`   Processing: ${obj.Key} (${sizeKB.toFixed(0)}KB)`);

            try {
                // 1. Download
                const original = await s3.getObject({ Bucket: BUCKET_NAME, Key: obj.Key }).promise();

                // 2. Resize
                const resizedBuffer = await sharp(original.Body)
                    .resize({ width: TARGET_WIDTH, withoutEnlargement: true })
                    .jpeg({ quality: QUALITY })
                    .toBuffer();
                
                // Safety check: Did we actually save space?
                if (resizedBuffer.length >= original.Body.length) {
                    console.log(`     ⚠️  Resizing didn't save space. Skipping.`);
                    continue;
                }

                // 3. BACKUP ORIGINAL (Safety First!)
                // Save 'image.jpg' -> 'image_original.jpg'
                const backupKey = obj.Key.replace('.jpg', '_original.jpg');
                await s3.copyObject({
                    Bucket: BUCKET_NAME,
                    CopySource: `${BUCKET_NAME}/${obj.Key}`,
                    Key: backupKey,
                }).promise();
                // console.log(`     💾 Backed up to: ${backupKey}`);

                // 4. OVERWRITE (The Fix)
                await s3.putObject({
                    Bucket: BUCKET_NAME,
                    Key: obj.Key, // <--- OVERWRITES THE LIVE FILE
                    Body: resizedBuffer,
                    ContentType: 'image/jpeg',
                    CacheControl: 'max-age=0' // Tell clients to refresh immediately
                }).promise();

                const newSizeKB = (resizedBuffer.length / 1024).toFixed(0);
                console.log(`     ✅ Fixed! ${sizeKB.toFixed(0)}KB -> ${newSizeKB}KB`);

            } catch (err) {
                console.error(`     ❌ ERROR: ${err.message}`);
            }
        }
    } while (token);
}

async function run() {
    for (const prefix of PREFIXES) {
        await processPrefix(prefix);
    }
    console.log("\n🎉 All folders scanned.");
}

run();