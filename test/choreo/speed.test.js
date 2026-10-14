import { describe, expect, it } from "vitest";
import { SPEEDS, advance, encodeWav, formatSpeed, normalizeSpeed } from "../../public/js/choreo/lib/speed.js";
import { stepTime } from "../../public/js/choreo/lib/timeline.js";

describe("Langsamer üben", () => {
  it("kennt nur feste Stufen, 1 = Original", () => {
    expect(SPEEDS).toContain(1);
    expect(normalizeSpeed("0.75")).toBe(0.75);
    expect(normalizeSpeed(0.33)).toBe(1);
    expect(normalizeSpeed(null)).toBe(1);
    expect(formatSpeed(0.75)).toBe("0,75×");
  });

  it("Playhead-Uhr: bei 0,75× vergeht in 1 s Echtzeit 0,75 s Musik", () => {
    expect(advance(10, 1000, 1)).toBe(11);
    expect(advance(10, 1000, 0.75)).toBe(10.75);
    expect(advance(10, 2000, 0.5)).toBe(11);
  });

  it("Raster hängt an der Musik-Zeit: ein Schritt liegt bei jedem Tempo an derselben Stelle der Musik", () => {
    const tempo = [{ id: "t", bpm: 120, offset_sec: 0.5 }];
    const step = { tempo_section_id: "t", beat_pos: 8 };
    const at = stepTime(step, tempo); // 4,5 s in der Musik
    expect(at).toBe(4.5);
    // bei 0,75× ist er nach 6 s Echtzeit erreicht, bei 1× nach 4,5 s – dieselbe Musik-Zeit
    expect(advance(0, 6000, 0.75)).toBeCloseTo(at, 10);
    expect(advance(0, 4500, 1)).toBeCloseTo(at, 10);
  });

  it("WAV: gültiger Kopf, Länge und Samples bleiben gleich (gleiche Zeitachse)", async () => {
    const left = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const right = new Float32Array([0, -0.25, 0.25, 0.1, -0.1]);
    const buffer = { numberOfChannels: 2, sampleRate: 44100, length: 5, getChannelData: (c) => (c ? right : left) };
    const blob = encodeWav(buffer);
    const bytes = new DataView(await blob.arrayBuffer());
    const str = (o, n) => String.fromCharCode(...Array.from({ length: n }, (_, i) => bytes.getUint8(o + i)));
    expect(str(0, 4)).toBe("RIFF");
    expect(str(8, 4)).toBe("WAVE");
    expect(bytes.getUint16(22, true)).toBe(2); // Kanäle
    expect(bytes.getUint32(24, true)).toBe(44100);
    expect(bytes.getUint32(40, true)).toBe(5 * 2 * 2); // Daten-Bytes
    expect(blob.size).toBe(44 + 20);
    // L/R verschränkt
    expect(bytes.getInt16(44 + 4 * 1, true)).toBe(16383); // 0,5 (abgeschnitten wie Int16Array)
    expect(bytes.getInt16(44 + 4 * 1 + 2, true)).toBe(-8192); // rechts −0,25
    expect(bytes.getInt16(44 + 4 * 3, true)).toBe(0x7fff); // 1.0
    expect(bytes.getInt16(44 + 4 * 4, true)).toBe(-0x8000); // -1.0
    // Dauer = Frames / Rate – exakt wie im dekodierten Original
    expect((blob.size - 44) / (2 * 2) / 44100).toBe(5 / 44100);
  });
});
