import { HttpError } from "./http.js";

const TYPES_BY_EXT = {
  mov: "video/quicktime",
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  webm: "video/webm",
  "3gp": "video/3gpp",
};

/** Endung aus einer festen Liste, sonst "bin" – der Dateiname des Nutzers landet nie im Key. */
export function extensionFor(filename) {
  const match = /\.([a-z0-9]{2,4})$/i.exec(String(filename ?? ""));
  const ext = match?.[1].toLowerCase();
  return ext && ext in TYPES_BY_EXT ? ext : "bin";
}

/** Content-Type vom Browser, oder aus der Endung abgeleitet (Android liefert manchmal keinen). */
export function contentTypeFor(given, ext) {
  const type = String(given ?? "").trim().toLowerCase();
  if (type.startsWith("video/")) return type;
  if (!type && TYPES_BY_EXT[ext]) return TYPES_BY_EXT[ext];
  return null;
}

export function optionalText(value, maxLength, field) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > maxLength) throw new HttpError(400, `${field} ist zu lang`);
  return text;
}

/**
 * Aufnahmezeitpunkt: ein ISO-Zeitpunkt („2026-09-25T10:31:02Z“, auch mit Versatz) oder
 * nur ein Datum („2026-09-25“). Zeitpunkte werden nach UTC umgerechnet. Unsinnige Jahre
 * (z. B. 1904 aus leeren Video-Metadaten) werden abgelehnt.
 */
export function optionalTimestamp(value) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text))) return checkYear(text);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    const date = new Date(text.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
    if (!Number.isNaN(date.getTime())) return checkYear(date.toISOString());
  }
  throw new HttpError(400, "Aufnahmezeit ist ungültig");
}

function checkYear(iso) {
  const year = Number(iso.slice(0, 4));
  if (year < 2000 || year > 2100) throw new HttpError(400, "Aufnahmezeit ist ungültig");
  return iso;
}

/** Zahl in einem Bereich oder null. */
export function optionalNumber(value, min, max, field) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${field} ist ungültig`);
  return n;
}

/** Liste von IDs (höchstens `max`, ohne Doppelte). */
export function idList(value, field, max = 50) {
  if (!Array.isArray(value) || value.length > max) throw new HttpError(400, `${field}: Liste erwartet`);
  for (const id of value) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new HttpError(400, `${field}: ungültige ID`);
  }
  return [...new Set(value)];
}
