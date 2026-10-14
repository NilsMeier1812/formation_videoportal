// Langsamer üben: Tempostufen, Uhr mit Tempo-Faktor und WAV-Kodierung (rein, testbar).
//
// Alle Daten des Planers (Raster, Schritte, Sprungmarken, Abschnitte, Videos) hängen an der
// Zeit IN DER MUSIK. Langsamer abspielen ändert nur, wie schnell diese Zeit vergeht – nicht
// die Zeit selbst. Deshalb muss nur die Playhead-Uhr (Echtzeit → Musik-Zeit) den Faktor kennen.

/** Wählbare Tempostufen (1 = Original). */
export const SPEEDS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1];

/** Nur bekannte Stufen zulassen; alles andere → 1. */
export function normalizeSpeed(value) {
  const n = Number(value);
  return SPEEDS.includes(n) ? n : 1;
}

/** „0,75×“ */
export function formatSpeed(rate) {
  return `${String(rate).replace(".", ",")}×`;
}

/** Musik-Zeit nach `elapsedMs` Echtzeit, ausgehend von `musicTime`, bei Tempo `rate`. */
export function advance(musicTime, elapsedMs, rate = 1) {
  return musicTime + (elapsedMs / 1000) * rate;
}

/**
 * AudioBuffer (oder { numberOfChannels, sampleRate, length, getChannelData(i) }) → WAV
 * (16 Bit PCM). Verlustfrei gegenüber dem, was WebAudio dekodiert hat: gleiche Samples,
 * gleiche Zeitachse – Raster und Welle passen genau wie bei 1×.
 */
export function encodeWav(buffer) {
  const channels = Math.min(2, buffer.numberOfChannels);
  const rate = buffer.sampleRate;
  const frames = buffer.length;
  const bytesPerSample = 2;
  const dataBytes = frames * channels * bytesPerSample;
  const out = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(out);
  const text = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };
  text(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true); // Länge des fmt-Blocks
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, dataBytes, true);

  const data = [];
  for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));
  const pcm = new Int16Array(out, 44, frames * channels);
  for (let i = 0, k = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++, k++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      pcm[k] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  }
  return new Blob([out], { type: "audio/wav" });
}
