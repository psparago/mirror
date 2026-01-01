/**
 * Uploads a photo to S3 using a presigned URL
 * @param photoUri - Local file URI from camera or remote URL (e.g., Unsplash)
 * @param presignedUrl - Presigned PUT URL from backend
 * @returns Promise that resolves when upload is complete
 */
export async function uploadPhotoToS3(
  photoUri: string,
  presignedUrl: string
): Promise<Response> {
  // Convert URI to blob for upload
  // For remote URLs (like Unsplash), handle redirects and ensure proper headers
  const blobResponse = await fetch(photoUri, {
    method: 'GET',
    redirect: 'follow', // Follow redirects
    mode: 'cors', // Handle CORS
  });

  if (!blobResponse.ok) {
    throw new Error(`Failed to fetch image: ${blobResponse.status} ${blobResponse.statusText}`);
  }

  const blob = await blobResponse.blob();

  // Verify we got an image, not an error page
  if (blob.size < 1000) {
    const text = await blob.text();
    if (text.includes('<!DOCTYPE') || text.includes('<html') || text.includes('error')) {
      throw new Error(`Received error page instead of image (${blob.size} bytes)`);
    }
  }

  // Upload to S3
  const uploadResponse = await fetch(presignedUrl, {
    method: 'PUT',
    body: blob,
    headers: {
      'Content-Type': blob.type || 'image/jpeg',
    },
  });

  return uploadResponse;
}

