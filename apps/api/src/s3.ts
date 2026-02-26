import { randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "./config.js";

export const s3Client = new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  forcePathStyle: config.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: config.S3_ACCESS_KEY,
    secretAccessKey: config.S3_SECRET_KEY
  }
});

export async function createAudioUploadUrl(recordingId: string, mimeType: string) {
  const objectKey = `audio/${recordingId}/${randomUUID()}.webm`;
  const command = new PutObjectCommand({
    Bucket: config.S3_BUCKET,
    Key: objectKey,
    ContentType: mimeType
  });
  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 });
  return { objectKey, uploadUrl };
}
