import { describe, expect, it } from "vitest";
import { advance, encodeWav, formatBpm, formatSpeed, normalizeSpeed, peaksFrom, stepSpeed, tempoLines } from "../../public/js/choreo/lib/speed.js";
import { stepTime } from "../../public/js/choreo/lib/timeline.js";

describe("Langsamer üben", () => {
  it("Tempo in ganzen Prozent zwischen 75 und 125, Unsinn → 100 %", () => {
    expect(normalizeSpeed("0.93")).toBe(0.93);
    expect(normalizeSpeed(0.934)).toBe(0.93);
    expect(normalizeSpeed(0.5)).toBe(0.75);
    expect(normalizeSpeed(1.4)).toBe(1.25);
    expect(normalizeSpeed(1.1)).toBe(1.1);
    expect(normalizeSpeed(null)).toBe(1);
    expect(normalizeSpeed("abc")).toBe(1);
    expect(formatSpeed(0.93)).toBe("93 %");
    expect(formatSpeed(1.07)).toBe("107 %");
  });

  it("+/− ändert um genau 1 %, auch über 100 % hinaus; an den Grenzen bleibt es stehen", () => {
    expect(stepSpeed(1, -1)).toBe(0.99);
    expect(stepSpeed(1, 1)).toBe(1.01);
    expect(stepSpeed(1.25, 1)).toBe(1.25);
    expect(stepSpeed(0.75, -1)).toBe(0.75);
    let r = 1;
    for (let i = 0; i < 7; i++) r = stepSpeed(r, -1);
    expect(r).toBe(0.93);
    for (let i = 0; i < 17; i++) r = stepSpeed(r, 1);
    expect(r).toBe(1.1);
  });

  it("verkleinerte Welle: größter Ausschlag je Abschnitt, mit Vorzeichen", () => {
    const samples = new Float32Array([0.1, -0.9, 0.2, 0.3, 0.5, -0.4, 0, 0.05]);
    expect(Array.from(peaksFrom(samples, 8, 2))).toEqual([Math.fround(-0.9), Math.fround(0.5)]);
    expect(peaksFrom(new Float32Array(44100 * 2), 44100).length).toBe(8019); // 2 s, je 11 Samples → ~4000 je Sekunde
  });

  it("BPM der Tänze werden mitgerechnet", () => {
    expect(formatBpm(98, 0.93)).toBe("91,1");
    expect(formatBpm(120, 0.5)).toBe("60");
    const names = { std: "Standard", lat: "Latein" };
    const sections = [
      { dance_id: null, bpm: 120, label: "Intro" },
      { dance_id: "std", bpm: 120 },
      { dance_id: "lat", bpm: 98 },
      { dance_id: "lat", bpm: 98 },
      { dance_id: "lat", bpm: 104 },
    ];
    const lines = tempoLines(sections, (id) => names[id], 0.9);
    expect(lines.map((l) => `${l.label} ${l.original}→${l.scaled}`)).toEqual(["Standard 120→108", "Latein 98→88,2", "Latein 104→93,6"]);
    // ohne Tänze: das Tempo der Musik
    expect(tempoLines([{ dance_id: null, bpm: 120 }], () => null, 0.75)).toEqual([{ label: "Musik", bpm: 120, scaled: "90", original: "120" }]);
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
