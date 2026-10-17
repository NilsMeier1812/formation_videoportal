import { describe, expect, it } from "vitest";
import { ZOOM_MAX, clampZoom, fitZoom, scrollFor, wheelFactor } from "../../public/js/choreo/lib/zoom.js";

describe("Zoom", () => {
  it("begrenzt auf ganzes Lied … Maximum", () => {
    expect(fitZoom(390, 195)).toBe(2);
    expect(clampZoom(0.5, 390, 195)).toBe(2); // weiter raus als ganzes Lied geht nicht
    expect(clampZoom(50, 390, 195)).toBe(50);
    expect(clampZoom(9999, 390, 195)).toBe(ZOOM_MAX);
    expect(clampZoom(NaN, 390, 195)).toBe(2);
    expect(clampZoom(10, 390, 0)).toBe(10); // Länge noch unbekannt
    expect(clampZoom(10, 1000, 1)).toBe(1000); // sehr kurz: passt immer ganz hinein
  });

  it("hält die Stelle unter dem Finger fest", () => {
    // 40 s bei 50 px/s steht an x = 100 → scroll 1900
    expect(scrollFor({ time: 40, anchorX: 100, pxPerSec: 50, width: 390, duration: 180 })).toBe(1900);
    // am Anfang / Ende nicht über das Lied hinaus
    expect(scrollFor({ time: 1, anchorX: 200, pxPerSec: 50, width: 390, duration: 180 })).toBe(0);
    expect(scrollFor({ time: 179, anchorX: 0, pxPerSec: 50, width: 390, duration: 180 })).toBe(180 * 50 - 390);
    // ganzes Lied im Bild → kein Scroll
    expect(scrollFor({ time: 90, anchorX: 10, pxPerSec: 2, width: 390, duration: 180 })).toBe(0);
  });

  it("Mausrad: hoch = rein, runter = raus, begrenzt pro Ereignis", () => {
    expect(wheelFactor({ deltaY: -100 })).toBeGreaterThan(1);
    expect(wheelFactor({ deltaY: 100 })).toBeLessThan(1);
    expect(wheelFactor({ deltaY: 100 }) * wheelFactor({ deltaY: -100 })).toBeCloseTo(1, 10); // symmetrisch
    expect(wheelFactor({ deltaY: -3, deltaMode: 1 })).toBeCloseTo(wheelFactor({ deltaY: -48 }), 10); // Zeilen
    expect(wheelFactor({ deltaY: -5000 })).toBe(2);
    expect(wheelFactor({ deltaY: 5000 })).toBe(0.5);
    expect(wheelFactor({ deltaY: -10, ctrlKey: true })).toBeGreaterThan(wheelFactor({ deltaY: -10 })); // Touchpad-Zoom feiner gemeldet
    expect(wheelFactor({})).toBe(1);
  });
});
