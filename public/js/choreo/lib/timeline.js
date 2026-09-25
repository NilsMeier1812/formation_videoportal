// Reine Rechenlogik rund um die Zeitleiste: Takt, Beats, Abschnitte, Gruppen.
// Keine DOM-, Alpine- oder Datenbank-Abhängigkeiten – dadurch einzeln testbar
// und später auch im Videoportal nutzbar (z. B. Takt einer Sprungmarke).

const EPS = 1e-6;

export function beatsPerBar(timeSignature) {
  return parseInt(String(timeSignature || "4/4").split("/")[0], 10) || 4;
}

export function secondsPerBeat(tempo) {
  return 60 / (Number(tempo.bpm) || 120);
}

/** Takt-Länge (Abstand der dicken Rasterlinien) in Sekunden. */
export function barLength(tempo) {
  if (!tempo) return 0;
  return secondsPerBeat(tempo) * beatsPerBar(tempo.time_signature);
}

/** Aufsteigend nach einem Zahlenfeld sortierte Kopie. */
export function sortBy(list, field) {
  return [...list].sort((a, b) => Number(a[field]) - Number(b[field]));
}

/** Eintrag, dessen [start_sec, end_sec) die Zeit enthält; end_sec null = bis zum Schluss. */
export function rangeAt(sorted, t) {
  for (const item of sorted) {
    const end = item.end_sec == null ? Infinity : Number(item.end_sec);
    if (t >= Number(item.start_sec) - EPS && t < end) return item;
  }
  return null;
}

/** Tempo-Abschnitt an einer Zeit; außerhalb aller Abschnitte der erste. */
export function tempoAt(sortedTempo, t) {
  return rangeAt(sortedTempo, t) || sortedTempo[0] || null;
}

/** Absolute Zeit eines Schritts (Beat → Sekunde über seinen Tempo-Abschnitt). */
export function stepTime(step, tempoSections) {
  const tempo = tempoSections.find((x) => x.id === step.tempo_section_id);
  if (!tempo) return null;
  return Number(tempo.offset_sec || 0) + Number(step.beat_pos) * secondsPerBeat(tempo);
}

/** Zeit → Beat im Raster des Abschnitts, immer auf ½-Beats gerundet. */
export function snapBeat(tempo, time) {
  const beat = Math.round((time - Number(tempo.offset_sec || 0)) / secondsPerBeat(tempo) / 0.5) * 0.5;
  return beat < 0 ? 0 : beat;
}

export function isOffbeat(step) {
  const b = Number(step.beat_pos);
  return Math.abs(b - Math.round(b)) > 0.1;
}

/** Zählzeit im Takt (1..n) eines Schritts. */
export function countInBar(step, tempo) {
  const bpb = beatsPerBar(tempo.time_signature);
  const base = Math.floor(Number(step.beat_pos) + EPS);
  return (((base % bpb) + bpb) % bpb) + 1;
}

/** Letzte Sprungmarke, die zur Zeit t schon erreicht ist. */
export function segmentAt(sortedSegments, t) {
  let active = null;
  for (const s of sortedSegments) {
    if (Number(s.timestamp) <= t + 0.001) active = s;
    else break;
  }
  return active;
}

// ---- Gruppen ----

/** Gruppe einer Person in einem Abschnitt (0 = keine/„alle gleich"). */
export function groupOf(memberships, part, personNumber) {
  if (!part) return 0;
  const m = memberships.find(
    (x) => x.part_id === part.id && Number(x.person_number) === Number(personNumber)
  );
  return m ? Number(m.group_number) : 0;
}

/** Definierte Gruppen-Nummern eines Abschnitts (aus part.group_names). */
export function groupNumbersOf(part) {
  const names = (part && part.group_names) || {};
  return Object.keys(names).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
}

export function groupNameOf(part, n) {
  if (!n) return "alle";
  const names = (part && part.group_names) || {};
  return (names[n] && String(names[n]).trim()) || "Gruppe " + n;
}

/**
 * Verlauf der Gruppen einer Person über das ganze Lied,
 * z. B. ["Links", "Alle gleich", "Mitte"]. Gleiche Nachbarn werden zusammengefasst.
 */
export function groupTimeline(sortedParts, memberships, personNumber, duration) {
  if (!personNumber) return [];
  const out = [];
  let cursor = 0;
  for (const p of sortedParts) {
    const start = Number(p.start_sec) || 0;
    const end = p.end_sec == null ? duration : Number(p.end_sec);
    if (start > cursor + 0.05) out.push("Alle gleich"); // Lücke davor
    const g = groupOf(memberships, p, personNumber);
    out.push(g ? groupNameOf(p, g) : "Alle gleich");
    cursor = Math.max(cursor, end);
  }
  if (!sortedParts.length || cursor < duration - 0.05) out.push("Alle gleich"); // Rest
  const merged = [];
  for (const x of out) if (merged[merged.length - 1] !== x) merged.push(x);
  return merged;
}
