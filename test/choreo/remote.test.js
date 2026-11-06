import { describe, expect, it } from "vitest";
import { backoff, controllerLabel, controllerShort, mirrorTime, remoteUrl } from "../../public/js/choreo/lib/remote.js";

describe("Fernsteuerung: Stelle des PCs am Handy", () => {
  const playing = { time: 10, playing: true, rate: 1, duration: 60 };
  it("läuft weiter, solange der PC spielt – im Tempo des PCs", () => {
    expect(mirrorTime(playing, 2500)).toBe(12.5);
    expect(mirrorTime({ ...playing, rate: 0.8 }, 5000)).toBe(14);
  });
  it("steht, wenn pausiert", () => {
    expect(mirrorTime({ ...playing, playing: false }, 5000)).toBe(10);
  });
  it("nie über das Ende, nie negativ", () => {
    expect(mirrorTime(playing, 120000)).toBe(60);
    expect(mirrorTime(playing, 120000, 30)).toBe(30); // Dauer der eigenen Welle zählt
    expect(mirrorTime({ ...playing, time: -1, playing: false }, 0)).toBe(0);
    expect(mirrorTime(playing, -500)).toBe(10); // Uhr-Ruckler
    expect(mirrorTime(null, 100)).toBe(0);
  });
});

describe("Fernsteuerung: Verbindung", () => {
  it("wartet beim Wiederverbinden erst kurz, dann länger (höchstens 10 s)", () => {
    expect([0, 1, 2, 3, 4, 9].map(backoff)).toEqual([1000, 2000, 4000, 8000, 10000, 10000]);
  });
  it("Adresse passend zu http/https", () => {
    expect(remoteUrl({ protocol: "https:", host: "formation.nils-meier.de" }, "ctrl")).toBe("wss://formation.nils-meier.de/api/remote?as=ctrl");
    expect(remoteUrl({ protocol: "http:", host: "localhost:8787" }, "host")).toBe("ws://localhost:8787/api/remote?as=host");
  });
  it("sagt, was los ist", () => {
    expect(controllerShort({ connected: false })).toBe("Verbinde …");
    expect(controllerShort({ connected: true, hostOnline: false })).toBe("Kein Musik-PC");
    expect(controllerShort({ connected: true, hostOnline: true })).toBe("PC verbunden");
    expect(controllerLabel({ connected: true, hostOnline: false })).toMatch(/Musik an diesem Gerät/);
  });
});
