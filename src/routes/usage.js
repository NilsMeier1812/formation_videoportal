// Nutzung (anonym): Wie viele Geräte nutzen die App pro Tag, und wie oft wird sie geöffnet?
// Die App meldet sich still im Hintergrund (public/js/usage.js) – höchstens alle 30 Minuten
// je Gerät. Gespeichert wird je Tag nur ein Hash aus Geräte-Kennung und Datum: So lässt sich
// pro Tag zählen, aber kein Gerät über mehrere Tage verfolgen. Keine Namen, keine IPs.
// Auswerten dürfen nur Trainer (Verwalten → Mehr).
import { requireRole } from "../lib/auth.js";
import { HttpError, json, readJson } from "../lib/http.js";

const TIME_ZONE = "Europe/Berlin";
export const USAGE_KEEP_DAYS = 400;
const MAX_DAYS = 366;

/** Kalendertag in Berlin als „YYYY-MM-DD“. */
export function berlinDay(now = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(now));
}

async function dayHash(device, day) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${day}:${device}`)));
  return [...bytes.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// POST /api/usage { device } – zählt einen Aufruf (angemeldet: Gruppe oder Trainer)
export async function recordUsage(request, env) {
  const role = await requireRole(request, env, "group");
  const { device } = await readJson(request);
  if (typeof device !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(device)) throw new HttpError(400, "Ungültiges Gerät");
  const day = berlinDay();
  await env.DB.prepare(
    `INSERT INTO usage_days (day, device, role, opens) VALUES (?, ?, ?, 1)
     ON CONFLICT(day, device) DO UPDATE SET opens = opens + 1, role = excluded.role`
  ).bind(day, await dayHash(device, day), role).run();
  return new Response(null, { status: 204 });
}

// GET /api/usage?days=56 – je Tag: Geräte (davon Trainer) und Aufrufe; nur Trainer
export async function usageStats(request, env) {
  await requireRole(request, env, "tagger");
  const days = Math.min(MAX_DAYS, Math.max(1, Number(new URL(request.url).searchParams.get("days")) || 56));
  const today = berlinDay();
  const from = berlinDay(Date.parse(`${today}T12:00:00Z`) - (days - 1) * 86400000);
  const { results } = await env.DB.prepare(
    `SELECT day, COUNT(*) AS devices, SUM(role = 'tagger') AS trainers, SUM(opens) AS opens
       FROM usage_days WHERE day >= ? GROUP BY day ORDER BY day`
  ).bind(from).all();
  return json({ from, today, days: results });
}

/** Cron (täglich): alte Tage löschen. */
export async function purgeUsage(env, now = Date.now()) {
  const before = berlinDay(now - USAGE_KEEP_DAYS * 86400000);
  const { meta } = await env.DB.prepare("DELETE FROM usage_days WHERE day < ?").bind(before).run();
  return meta.changes || 0;
}
