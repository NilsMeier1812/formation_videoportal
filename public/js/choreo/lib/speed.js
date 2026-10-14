// Langsamer üben: Tempo in Prozent, Uhr mit Tempo-Faktor, umgerechnete BPM und WAV-Kodierung
// (rein, testbar).
//
// Alle Daten des Planers (Raster, Schritte, Sprungmarken, Abschnitte, Videos) hängen an der
// Zeit IN DER MUSIK. Langsamer abspielen ändert nur, wie schnell diese Zeit vergeht – nicht
// die Zeit selbst. Deshalb muss nur die Playhead-Uhr (Echtzeit → Musik-Zeit) den Faktor kennen.

export const SPEED_MIN = 0.5; // 50 %
export const SPEED_MAX = 1; // 100 % = Original

/** Auf ganze Prozent zwischen 50 und 100 bringen; Unsinn → 100 %. */
export function normalizeSpeed(value) {
  const n = Number(value);
  if (value === null || value === "" || !Number.isFinite(n) || n <= 0) return 1;
  const pct = Math.round(n * 100);
  return Math.min(SPEED_MAX * 100, Math.max(SPEED_MIN * 100, pct)) / 100;
}

/** Ein Prozent mehr (+1) oder weniger (−1). */
export function stepSpeed(rate, direction) {
  return normalizeSpeed((Math.round(rate * 100) + Math.sign(direction)) / 100);
}

/** „93 %“ */
export function formatSpeed(rate) {
  return `${Math.round(rate * 100)} %`;
}

/** BPM bei diesem Tempo, auf eine Nachkommastelle („91,1“, ganze ohne „,0“). */
export function formatBpm(bpm, rate = 1) {
  const v = Math.round(Number(bpm) * rate * 10) / 10;
  return String(v).replace(".", ",");
}

/**
 * Tempo der Abschnitte für die Anzeige: [{ label, bpm, scaled }] in Reihenfolge der Musik.
 * Gibt es Tänze, nur die Abschnitte mit Tanz; gleiche aufeinanderfolgende zusammengefasst.
 */
export function tempoLines(sections, nameOf, rate = 1) {
  const named = sections.filter((s) => nameOf(s.dance_id));
  const list = named.length ? named : sections;
  const out = [];
  for (const s of list) {
    const label = nameOf(s.dance_id) || (list.length > 1 ? s.label || "Abschnitt" : "Musik");
    const last = out[out.length - 1];
    if (last && last.label === label && last.bpm === Number(s.bpm)) continue;
    out.push({ label, bpm: Number(s.bpm), scaled: formatBpm(s.bpm, rate), original: formatBpm(s.bpm) });
  }
  return out;
}

/** Musik-Zeit nach `elapsedMs` Echtzeit, ausgehend von `musicTime`, bei Tempo `rate`. */
export function advance(musicTime, elapsedMs, rate = 1) {
  return musicTime + (elapsedMs / 1000) * rate;
}

/**
 * AudioBuffer (oder { numberOfChannels, sampleRate, length, getChannelData(i) }) → WAV
 * (16 Bit PCM). Verlustfrei gegenüber dem, was WebAudio dekodiert hat: gleiche Samples,
 * gleiche Zeitachse – Raster und Welle passen genau wie bei 100 %.
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
