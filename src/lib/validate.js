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

export function optionalDate(value) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text))) {
    throw new HttpError(400, "Datum muss im Format JJJJ-MM-TT sein");
  }
  return text;
}
