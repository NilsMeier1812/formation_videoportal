export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const API_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow",
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...API_HEADERS, ...extraHeaders } });
}

export function errorResponse(status, message) {
  return json({ error: message }, status);
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "Ungültiges JSON");
  }
}
