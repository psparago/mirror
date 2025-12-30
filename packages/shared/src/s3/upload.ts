/**
 * Uploads a photo to S3 using a presigned URL
 * @param photoUri - Local file URI from camera
 * @param presignedUrl - Presigned PUT URL from backend
 * @returns Promise that resolves when upload is complete
 */
export async function uploadPhotoToS3(
  photoUri: string,
  presignedUrl: string
): Promise<Response> {
  // Convert URI to blob for upload
  const blobResponse = await fetch(photoUri);
  const blob = await blobResponse.blob();

  // Upload to S3
  const uploadResponse = await fetch(presignedUrl, {
    method: 'PUT',
    body: blob,
    headers: {
      'Content-Type': 'image/jpeg',
    },
  });

  return uploadResponse;
}

