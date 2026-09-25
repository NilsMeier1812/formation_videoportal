// Gemeinsame Helfer der Video-Bereiche: API-Aufrufe und kleine DOM-Helfer.
// Die Anmeldung steht in session.js.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Fehler ${res.status}`);
  return data;
}

// ---------------- DOM ----------------

/** Kleiner DOM-Helfer; Text immer über textContent, nie als HTML. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** SVG-Symbol aus einer Pfadliste (currentColor, 24er-Raster). */
export function icon(paths, size = 20) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor",
    "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
  })) svg.setAttribute(k, v);
  svg.innerHTML = paths; // nur feste Pfade aus dem Code, nie Nutzereingaben
  return svg;
}

const two = (n) => String(n).padStart(2, "0");

/** Datum (TT.MM.JJJJ). Zeitpunkte (mit „T“) in Ortszeit, reine Daten wie angegeben. */
export function formatDate(iso) {
  if (!iso) return "";
  if (iso.includes("T")) {
    const d = new Date(iso);
    return `${two(d.getDate())}.${two(d.getMonth() + 1)}.${d.getFullYear()}`;
  }
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

/** Uhrzeit (HH:MM:SS) in Ortszeit – leer bei reinen Daten. */
export function formatTime(iso) {
  if (!iso || !iso.includes("T")) return "";
  const d = new Date(iso);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** Datum und Uhrzeit (ohne Sekunden), z. B. „25.09.2026, 12:31“. */
export function formatDateTime(iso) {
  const time = formatTime(iso).slice(0, 5);
  return time ? `${formatDate(iso)}, ${time}` : formatDate(iso);
}

export function formatDuration(sec) {
  if (!sec && sec !== 0) return "";
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function formatBytes(bytes) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) { value /= 1000; i++; }
  return `${value.toFixed(i >= 2 ? 1 : 0).replace(".", ",")} ${units[i]}`;
}
