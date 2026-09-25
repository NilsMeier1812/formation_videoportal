import { HttpError } from "./http.js";

const encoder = new TextEncoder();

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

// Vergleich in konstanter Zeit; die Hashes gleichen die Längen an.
async function codeMatches(given, expected) {
  if (!given || !expected) return false;
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/** @returns {Promise<"tagger" | "group" | null>} */
export async function roleFor(request, env) {
  const code = request.headers.get("x-portal-code");
  if (await codeMatches(code, env.TAGGER_CODE)) return "tagger";
  if (await codeMatches(code, env.GROUP_CODE)) return "group";
  return null;
}

const RANK = { group: 1, tagger: 2 };

/** Wirft 401, wenn der Code fehlt oder nicht mindestens die verlangte Rolle hat. */
export async function requireRole(request, env, needed) {
  const role = await roleFor(request, env);
  if (!role || RANK[role] < RANK[needed]) {
    throw new HttpError(401, "Code fehlt oder ist falsch");
  }
  return role;
}
