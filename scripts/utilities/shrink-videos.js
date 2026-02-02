require('dotenv').config();
const AWS = require('aws-sdk');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');

// --- CONFIG ---
const BUCKET_NAME = 'reflections-1200b-storage';
const MAX_DIMENSION = 1080; // Downscale to 1080p if larger
const TEMP_DIR = './temp_video_processing'; // Local scratch space

// Only these folders (Videos are usually only in "to" folders for reflections)
const PREFIXES = [
  'cole/to/',
  'peter/to/'
];

// --- SETUP ---
if (!process.env.AWS_ACCESS_KEY_ID) {
    console.error("❌ Missing AWS Credentials. Ensure .env is loaded.");
    process.exit(1);
}

// Create temp dir if it doesn't exist
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR);
}

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: 'us-east-1'
});

// Wrapper to make ffmpeg await-able
function compressVideo(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .outputOptions([
                // Scale to 1080p max (maintaining aspect ratio), prevent upscaling
                `-vf scale='min(${MAX_DIMENSION},iw)':-2`, 
                '-c:v libx264', // Use H.264
                '-crf 24',      // Constant Rate Factor (Lower = better quality, Higher = smaller). 23-28 is the sweet spot.
                '-preset medium', // Balance speed/compression
                '-c:a aac',     // Audio codec
                '-b:a 128k',    // Audio bitrate
                '-movflags +faststart' // Optimize for web streaming
            ])
            .save(outputPath)
            .on('end', () => resolve())
            .on('error', (err) => reject(err));
    });
}

async function processPrefix(prefix) {
    console.log(`\n📂 Scanning folder: ${prefix}...`);
    
    let token = null;
    do {
        const listParams = {
            Bucket: BUCKET_NAME,
            Prefix: prefix,
            ContinuationToken: token
        };
        
        const data = await s3.listObjectsV2(listParams).promise();
        token = data.NextContinuationToken;

        for (const obj of data.Contents) {
            // Filter: Must be video.mp4
            if (!obj.Key.endsWith('video.mp4')) continue;
            
            // Skip if backup already exists (Idempotency check)
            // We assume if _original exists, we already processed this one.
            const backupKey = obj.Key.replace('.mp4', '_original.mp4');
            try {
                await s3.headObject({ Bucket: BUCKET_NAME, Key: backupKey }).promise();
                // console.log(`   ⏭️  Skipping ${obj.Key} (Already processed)`);
                continue;
            } catch (e) {
                // If error is "NotFound", proceed. Otherwise throw.
                if (e.code !== 'NotFound') throw e;
            }

            const sizeMB = (obj.Size / 1024 / 1024).toFixed(2);
            console.log(`   🎬 Processing: ${obj.Key} (${sizeMB} MB)`);

            const localInput = path.join(TEMP_DIR, `input_${Date.now()}.mp4`);
            const localOutput = path.join(TEMP_DIR, `output_${Date.now()}.mp4`);

            try {
                // 1. Download
                const original = await s3.getObject({ Bucket: BUCKET_NAME, Key: obj.Key }).promise();
                fs.writeFileSync(localInput, original.Body);

                // 2. Compress
                // console.log(`      🔨 Compressing... (This may take a moment)`);
                await compressVideo(localInput, localOutput);

                // 3. Compare Sizes
                const stats = fs.statSync(localOutput);
                const newSizeMB = (stats.size / 1024 / 1024).toFixed(2);

                if (stats.size >= obj.Size) {
                    console.log(`      ⚠️  Compression didn't save space. Keeping original.`);
                    // Clean up and skip
                    fs.unlinkSync(localInput);
                    fs.unlinkSync(localOutput);
                    continue;
                }

                // 4. BACKUP ORIGINAL
                await s3.copyObject({
                    Bucket: BUCKET_NAME,
                    CopySource: `${BUCKET_NAME}/${obj.Key}`,
                    Key: backupKey,
                }).promise();

                // 5. OVERWRITE LIVE FILE
                const fileContent = fs.readFileSync(localOutput);
                await s3.putObject({
                    Bucket: BUCKET_NAME,
                    Key: obj.Key,
                    Body: fileContent,
                    ContentType: 'video/mp4',
                    CacheControl: 'max-age=0'
                }).promise();

                console.log(`      ✅ Fixed! ${sizeMB}MB -> ${newSizeMB}MB`);

                // Cleanup temps
                fs.unlinkSync(localInput);
                fs.unlinkSync(localOutput);

            } catch (err) {
                console.error(`      ❌ ERROR processing ${obj.Key}: ${err.message}`);
                // Try to clean up temps if they exist
                if (fs.existsSync(localInput)) fs.unlinkSync(localInput);
                if (fs.existsSync(localOutput)) fs.unlinkSync(localOutput);
            }
        }
    } while (token);
}

async function run() {
    try {
        for (const prefix of PREFIXES) {
            await processPrefix(prefix);
        }
        console.log("\n🎉 All folders scanned.");
    } finally {
        // Final cleanup of temp dir
        if (fs.existsSync(TEMP_DIR)) {
            fs.rmSync(TEMP_DIR, { recursive: true, force: true });
        }
    }
}

run();