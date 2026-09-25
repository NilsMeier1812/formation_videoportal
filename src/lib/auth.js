import { HttpError } from "./http.js";

// Zwei Rollen, keine Accounts:
//   group  – Gruppen-Code: Videos hochladen
//   tagger – Trainer-Code (Secret TAGGER_CODE): Choreos bearbeiten, taggen; darf alles, was group darf
//
// Der Code kommt entweder im Header X-Portal-Code (Video-Seiten) oder steckt in
// einem Login-Cookie, das nach einmaliger Eingabe ein Jahr gilt. Das Cookie ist
// mit dem Code der Rolle signiert: Wird ein Code geändert, sind alle Cookies
// dieser Rolle automatisch ungültig.

const encoder = new TextEncoder();
const RANK = { group: 1, tagger: 2 };
const CODE_FOR = { group: "GROUP_CODE", tagger: "TAGGER_CODE" };

export const SESSION_COOKIE = "formation_session";
const SESSION_MAX_AGE = 365 * 24 * 3600; // Sekunden

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

// Vergleich in konstanter Zeit; die Hashes gleichen die Längen an.
export async function codeMatches(given, expected) {
  if (!given || !expected) return false;
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/** Rolle zu einem eingegebenen Code, oder null. */
export async function roleForCode(code, env) {
  if (await codeMatches(code, env.TAGGER_CODE)) return "tagger";
  if (await codeMatches(code, env.GROUP_CODE)) return "group";
  return null;
}

// ---------------- Login-Cookie ----------------

async function sign(role, expires, env) {
  const secret = env[CODE_FOR[role]];
  if (!secret) return null;
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(`formation-session:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${role}.${expires}`)));
  return btoa(String.fromCharCode(...mac)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Set-Cookie-Header für eine neue Sitzung. */
export async function sessionCookie(role, env, now = Date.now()) {
  const expires = Math.floor(now / 1000) + SESSION_MAX_AGE;
  const value = `${role}.${expires}.${await sign(role, expires, env)}`;
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${SESSION_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

async function sessionRole(request, env) {
  const value = readCookie(request, SESSION_COOKIE);
  if (!value) return null;
  const [role, expires, mac] = value.split(".");
  if (!RANK[role] || !/^\d+$/.test(expires) || Number(expires) * 1000 < Date.now()) return null;
  const expected = await sign(role, expires, env);
  if (!expected || !mac) return null;
  return (await codeMatches(mac, expected)) ? role : null;
}

// ---------------- Prüfen ----------------

/** @returns {Promise<"tagger" | "group" | null>} */
export async function roleFor(request, env) {
  const code = request.headers.get("x-portal-code");
  if (code) return roleForCode(code, env);
  return sessionRole(request, env);
}

export function hasRole(role, needed) {
  return Boolean(role) && RANK[role] >= RANK[needed];
}

/** Wirft 401, wenn der Code fehlt oder nicht mindestens die verlangte Rolle hat. */
export async function requireRole(request, env, needed) {
  const role = await roleFor(request, env);
  if (!hasRole(role, needed)) throw new HttpError(401, "Code fehlt oder ist falsch");
  return role;
}
