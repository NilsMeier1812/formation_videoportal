import { AwsClient } from "aws4fetch";

// Das R2-Binding kann keine Presigned URLs erzeugen, dafür braucht es die S3-API.
// Achtung: die URL begrenzt weder Größe noch Content-Type – das prüft /complete.

function client(env) {
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new Error("R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY fehlen");
  }
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
}

function objectUrl(env, key, query = {}) {
  const url = new URL(`${env.R2_S3_ENDPOINT}/${env.BUCKET_NAME}/${key}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url;
}

/** Presigned PUT – für die ganze Datei oder (mit partNumber/uploadId) für einen Teil. */
export async function presignPut(env, key, expiresSeconds = 900, query = {}) {
  const url = objectUrl(env, key, query);
  url.searchParams.set("X-Amz-Expires", String(expiresSeconds));
  const signed = await client(env).sign(new Request(url, { method: "PUT" }), {
    aws: { signQuery: true },
  });
  return signed.url;
}

// ---------------- Multipart über die S3-API ----------------
// Anlegen und Abschließen laufen bewusst ebenfalls über S3 (nicht über das Binding),
// weil auch die Teile per S3 (Presigned URLs) hochgeladen werden.

async function s3(env, method, key, query, body) {
  const res = await client(env).fetch(objectUrl(env, key, query), { method, body });
  const text = await res.text();
  // S3 meldet manche Fehler beim Abschließen mit Status 200 und <Error> im Text
  if (!res.ok || /<Error>/.test(text)) {
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] || res.status;
    throw new Error(`R2 ${method} ${code}`);
  }
  return text;
}

export async function createMultipart(env, key, contentType) {
  const res = await client(env).fetch(objectUrl(env, key, { uploads: "" }), {
    method: "POST",
    headers: { "content-type": contentType },
  });
  const text = await res.text();
  const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(text)?.[1];
  if (!res.ok || !uploadId) throw new Error(`R2 CreateMultipartUpload ${res.status}`);
  return uploadId;
}

export async function completeMultipart(env, key, uploadId, parts) {
  const xml = "<CompleteMultipartUpload>" +
    parts.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>"${p.etag}"</ETag></Part>`).join("") +
    "</CompleteMultipartUpload>";
  await s3(env, "POST", key, { uploadId }, xml);
}

export async function abortMultipart(env, key, uploadId) {
  await s3(env, "DELETE", key, { uploadId });
}
