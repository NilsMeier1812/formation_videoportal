// Aufnahmezeit und Länge aus MP4/MOV-Dateien lesen – im Browser, ohne das Video
// zu laden: Gelesen wird nur das Inhaltsverzeichnis der Datei (Box „moov“), das
// meist wenige hundert KB groß ist (bei Android oft am Dateiende).
//
//   Aufnahmezeit: 1. Apple-Schlüssel com.apple.quicktime.creationdate (iPhone; mit Zeitzone)
//                 2. Erstellzeit im Film-Kopf „mvhd“ (Android u. a.; UTC)
//   Länge:        mvhd (Dauer / Zeitskala)

const EPOCH_1904 = 2082844800; // Sekunden von 1904 (MP4-Zählung) bis 1970
const MAX_MOOV = 64 * 1024 * 1024;
const APPLE_DATE_KEY = "com.apple.quicktime.creationdate";

const ascii = (bytes, from, to) => String.fromCharCode(...bytes.subarray(from, to));
const utf8 = (bytes) => new TextDecoder().decode(bytes);

/** Liest `length` Bytes ab `offset` aus einer Datei (File/Blob). */
export function blobReader(blob) {
  return async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
}

/** Kopf einer Box: Größe (inkl. Kopf), Typ, Länge des Kopfs. */
function boxHeader(view, bytes, at, end) {
  if (at + 8 > end) return null;
  let size = view.getUint32(at);
  const type = ascii(bytes, at + 4, at + 8);
  let header = 8;
  if (size === 1) {
    if (at + 16 > end) return null;
    size = Number(view.getBigUint64(at + 8));
    header = 16;
  } else if (size === 0) {
    size = end - at; // bis zum Ende
  }
  if (size < header) return null;
  return { size, type, header };
}

/** Kind-Boxen innerhalb [from, to) eines Puffers. */
function* children(view, bytes, from, to) {
  let at = from;
  while (at + 8 <= to) {
    const box = boxHeader(view, bytes, at, to);
    if (!box || at + box.size > to) return;
    yield { ...box, start: at, body: at + box.header, end: at + box.size };
    at += box.size;
  }
}

/** Sucht die oberste Box `moov` in der Datei und liefert ihren Inhalt. */
async function findMoov(read, fileSize) {
  let at = 0;
  for (let i = 0; i < 64 && at + 8 <= fileSize; i++) {
    const head = await read(at, 16);
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const box = boxHeader(view, head, 0, Math.min(16, fileSize - at));
    if (!box) return null;
    const size = view.getUint32(0) === 0 ? fileSize - at : box.size; // 0 = bis zum Dateiende
    if (box.type === "moov") {
      if (size > MAX_MOOV) return null;
      return read(at, size);
    }
    at += size;
  }
  return null;
}

/** mvhd: Erstellzeit (Date oder null) und Länge in Sekunden. */
function parseMvhd(view, box) {
  const version = view.getUint8(box.body);
  let created, timescale, duration;
  if (version === 1) {
    created = Number(view.getBigUint64(box.body + 4));
    timescale = view.getUint32(box.body + 20);
    duration = Number(view.getBigUint64(box.body + 24));
  } else {
    created = view.getUint32(box.body + 4);
    timescale = view.getUint32(box.body + 12);
    duration = view.getUint32(box.body + 16);
  }
  return {
    createdAt: created > EPOCH_1904 ? new Date((created - EPOCH_1904) * 1000) : null,
    duration: timescale ? duration / timescale : null,
  };
}

/** „2026-09-25T12:31:02+0200“ → Date (auch mit „+02:00“ oder „Z“). */
export function parseAppleDate(text) {
  const clean = String(text).trim().replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(clean)) return null;
  const date = new Date(clean);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** meta (QuickTime: keys + ilst) → Wert des Apple-Schlüssels für die Aufnahmezeit. */
function appleCreationDate(view, bytes, meta) {
  // ISO-„meta“ hat vor den Kindern 4 Byte Version/Flags, QuickTime-„meta“ nicht
  let from = meta.body;
  if (view.getUint32(from) === 0) from += 4;
  let keys = null;
  let ilst = null;
  for (const box of children(view, bytes, from, meta.end)) {
    if (box.type === "keys") keys = box;
    if (box.type === "ilst") ilst = box;
  }
  if (!keys || !ilst) return null;

  // keys: Version/Flags, Anzahl, dann je Eintrag: Größe, Namensraum, Name
  const names = [];
  let at = keys.body + 8;
  const count = view.getUint32(keys.body + 4);
  for (let i = 0; i < count && at + 8 <= keys.end; i++) {
    const size = view.getUint32(at);
    if (size < 8) break;
    names.push(ascii(bytes, at + 8, at + size));
    at += size;
  }
  const index = names.indexOf(APPLE_DATE_KEY) + 1; // ilst zählt ab 1
  if (!index) return null;

  // ilst: Kind-Box mit Typ = Index (als Zahl), darin „data“: Typ, Sprache, Wert
  for (const item of children(view, bytes, ilst.body, ilst.end)) {
    if (view.getUint32(item.start + 4) !== index) continue;
    for (const data of children(view, bytes, item.body, item.end)) {
      if (data.type === "data") return parseAppleDate(utf8(bytes.subarray(data.body + 8, data.end)));
    }
  }
  return null;
}

/** Durchsucht moov (auch udta) nach mvhd und meta. */
function parseMoov(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const top = boxHeader(view, bytes, 0, bytes.length);
  if (!top || top.type !== "moov") return { createdAt: null, duration: null };
  let result = { createdAt: null, duration: null };
  let apple = null;
  const visit = (from, to) => {
    for (const box of children(view, bytes, from, to)) {
      if (box.type === "mvhd") result = parseMvhd(view, box);
      else if (box.type === "meta") apple ??= appleCreationDate(view, bytes, box);
      else if (box.type === "udta") visit(box.body, box.end);
    }
  };
  visit(top.header, bytes.length);
  return { createdAt: apple ?? result.createdAt, duration: result.duration };
}

/**
 * Aufnahmezeit und Länge eines Videos. Gibt { createdAt: Date|null, duration: Sekunden|null }
 * zurück und wirft nie – bei fremden Formaten oder kaputten Dateien kommt einfach null.
 */
export async function readVideoMeta(read, fileSize) {
  try {
    const moov = await findMoov(read, fileSize);
    if (!moov) return { createdAt: null, duration: null };
    return parseMoov(moov);
  } catch {
    return { createdAt: null, duration: null };
  }
}
