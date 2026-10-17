// Zoom der Welle (rein, testbar): Grenzen, Mausrad-Faktor und die Scroll-Position, bei der
// eine bestimmte Stelle der Musik unter dem Finger/Mauszeiger stehen bleibt.
//
// Zoom = Pixel pro Sekunde. Wavesurfer zeichnet mit max(Zoom, Breite / Dauer) – weiter raus
// als „ganzes Lied passt hinein“ geht also nicht.

export const ZOOM_MAX = 400; // px pro Sekunde

/** Zoom, bei dem das ganze Lied genau in die Breite passt. */
export function fitZoom(width, duration) {
  return width > 0 && duration > 0 ? width / duration : 1;
}

/** Auf den sinnvollen Bereich bringen: ganzes Lied … ZOOM_MAX. */
export function clampZoom(zoom, width, duration) {
  const lo = Math.max(1, fitZoom(width, duration));
  const hi = Math.max(ZOOM_MAX, lo);
  const z = Number.isFinite(zoom) ? zoom : lo;
  return Math.min(hi, Math.max(lo, z));
}

/** Scroll-Position, bei der `time` an Bildschirm-Position `anchorX` steht (begrenzt aufs Lied). */
export function scrollFor({ time, anchorX, pxPerSec, width, duration }) {
  const max = Math.max(0, duration * pxPerSec - width);
  return Math.min(max, Math.max(0, time * pxPerSec - anchorX));
}

/**
 * Zoom-Faktor für ein Mausrad-Ereignis: runter = raus, hoch = rein. Mit Strg (so meldet
 * auch das Touchpad das Zwei-Finger-Zoomen) feiner aufgelöst. Pro Ereignis höchstens ×2.
 */
export function wheelFactor({ deltaY = 0, deltaMode = 0, ctrlKey = false }) {
  const px = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1); // Zeilen/Seiten → Pixel
  const f = Math.exp(-px * (ctrlKey ? 0.01 : 0.0015));
  return Math.min(2, Math.max(0.5, f));
}
