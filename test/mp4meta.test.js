import { describe, expect, it } from "vitest";
import { blobReader, parseAppleDate, readVideoMeta } from "../public/js/lib/mp4meta.js";

// ---- kleine MP4-Bausteine ----
const enc = new TextEncoder();
function u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; }
function u64(n) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b; }
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
const type = (t) => (typeof t === "number" ? u32(t) : enc.encode(t));
const box = (t, ...body) => { const inner = concat(...body); return concat(u32(8 + inner.length), type(t), inner); };

const EPOCH_1904 = 2082844800;
const secs1904 = (iso) => Date.parse(iso) / 1000 + EPOCH_1904;

function mvhd({ created, timescale = 600, duration = 18000, version = 0 }) {
  if (version === 1) {
    return box("mvhd", u32(0x01000000), u64(created), u64(created), u32(timescale), u64(duration), new Uint8Array(80));
  }
  return box("mvhd", u32(0), u32(created), u32(created), u32(timescale), u32(duration), new Uint8Array(80));
}

/** QuickTime-meta wie beim iPhone: keys + ilst mit der Aufnahmezeit als Text. */
function appleMeta(dateText) {
  const key = (name) => concat(u32(8 + name.length), enc.encode("mdta"), enc.encode(name));
  const keys = box("keys", u32(0), u32(2), key("com.apple.quicktime.make"), key("com.apple.quicktime.creationdate"));
  const item = (index, text) => box(index, box("data", u32(1), u32(0), enc.encode(text)));
  const ilst = box("ilst", item(1, "Apple"), item(2, dateText));
  return box("meta", box("hdlr", u32(0), new Uint8Array(20)), keys, ilst);
}

const ftyp = box("ftyp", enc.encode("isom"), u32(0), enc.encode("isomiso2"));
const mdat = (n = 1000) => box("mdat", new Uint8Array(n));

async function meta(bytes) {
  return readVideoMeta(blobReader(new Blob([bytes])), bytes.length);
}

describe("Video-Metadaten", () => {
  it("liest Erstellzeit und Länge aus mvhd (moov am Dateiende, wie bei Android)", async () => {
    const file = concat(ftyp, mdat(5000), box("moov", mvhd({ created: secs1904("2026-09-25T10:31:02Z") })));
    const { createdAt, duration } = await meta(file);
    expect(createdAt.toISOString()).toBe("2026-09-25T10:31:02.000Z");
    expect(duration).toBe(30);
  });

  it("liest mvhd Version 1 (64 Bit) und moov am Anfang", async () => {
    const file = concat(ftyp, box("moov", mvhd({ version: 1, created: secs1904("2026-01-02T03:04:05Z"), timescale: 1000, duration: 12500 })), mdat());
    const { createdAt, duration } = await meta(file);
    expect(createdAt.toISOString()).toBe("2026-01-02T03:04:05.000Z");
    expect(duration).toBe(12.5);
  });

  it("bevorzugt die Apple-Aufnahmezeit mit Zeitzone (iPhone)", async () => {
    const moov = box("moov", mvhd({ created: secs1904("2026-09-25T10:40:00Z") }), appleMeta("2026-09-25T12:31:02+0200"));
    const { createdAt } = await meta(concat(ftyp, moov, mdat()));
    expect(createdAt.toISOString()).toBe("2026-09-25T10:31:02.000Z");
  });

  it("findet meta auch unter udta", async () => {
    const moov = box("moov", mvhd({ created: 0 }), box("udta", appleMeta("2026-09-25T12:31:02Z")));
    expect((await meta(concat(ftyp, moov))).createdAt.toISOString()).toBe("2026-09-25T12:31:02.000Z");
  });

  it("überspringt große mdat-Boxen mit 64-Bit-Größe", async () => {
    const big = concat(u32(1), enc.encode("mdat"), u64(16 + 2000), new Uint8Array(2000));
    const file = concat(ftyp, big, box("moov", mvhd({ created: secs1904("2026-09-25T10:00:00Z") })));
    expect((await meta(file)).createdAt.toISOString()).toBe("2026-09-25T10:00:00.000Z");
  });

  it("gibt null bei leerer Erstellzeit (1904) statt eines falschen Datums", async () => {
    const { createdAt, duration } = await meta(concat(ftyp, box("moov", mvhd({ created: 0 }))));
    expect(createdAt).toBeNull();
    expect(duration).toBe(30);
  });

  it("wirft nie – fremde oder kaputte Dateien geben null", async () => {
    expect(await meta(enc.encode("\x1aE\xdf\xa3 webm-kram"))).toEqual({ createdAt: null, duration: null });
    expect(await meta(new Uint8Array(0))).toEqual({ createdAt: null, duration: null });
    const kaputt = concat(ftyp, u32(999999), enc.encode("moov"), new Uint8Array(10));
    expect(await meta(kaputt)).toEqual({ createdAt: null, duration: null });
  });

  it("versteht die Apple-Datumsformate", () => {
    expect(parseAppleDate("2026-09-25T12:31:02+0200").toISOString()).toBe("2026-09-25T10:31:02.000Z");
    expect(parseAppleDate("2026-09-25T12:31:02-05:00").toISOString()).toBe("2026-09-25T17:31:02.000Z");
    expect(parseAppleDate("Quatsch")).toBeNull();
  });
});
