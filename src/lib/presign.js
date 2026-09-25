import { AwsClient } from "aws4fetch";

// Das R2-Binding kann keine Presigned URLs erzeugen, dafür braucht es die S3-API.
// Achtung: die URL begrenzt weder Größe noch Content-Type – das prüft /complete.
export async function presignPut(env, key, expiresSeconds = 900) {
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new Error("R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY fehlen");
  }
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
  const url = new URL(`${env.R2_S3_ENDPOINT}/${env.BUCKET_NAME}/${key}`);
  url.searchParams.set("X-Amz-Expires", String(expiresSeconds));
  const signed = await client.sign(new Request(url, { method: "PUT" }), {
    aws: { signQuery: true },
  });
  return signed.url;
}
