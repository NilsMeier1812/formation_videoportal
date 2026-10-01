// Umrechnen von Planer-Daten aus einer Audio in eine andere (rein, ohne DOM/Netz – testbar).
import { secondsPerBeat, stepTime, tempoAt } from "./timeline.js";
import { round3, uuid } from "./util.js";

/**
 * Rechnet die Zeilen einer Quell-Audio für die Ziel-Audio um (rein, ohne Netz – testbar).
 * Zeit im Ziel = Zeit in der Quelle + shift; Schritte/Notizen landen auf ½-Beats des
 * Ziel-Abschnitts an dieser Zeit. from/to (Sekunden in der Quelle, optional) begrenzen.
 */
export function buildCopy({ tempo, steps, segments, persons, parts, memberships, target, targetId, duration, existingNumbers, opts }) {
  const shift = opts.shift || 0;
  const inRange = (t) => (opts.from == null || t >= opts.from - 0.001) && (opts.to == null || t < opts.to);
  const fits = (t) => t >= -0.001 && (!duration || t <= duration + 0.05);
  const counts = { steps: 0, notes: 0, segments: 0, persons: 0, parts: 0, outside: 0 };
  const rows = { steps: [], choreo_segments: [], persons: [], parts: [], group_memberships: [] };

  for (const step of steps) {
    const isNote = step.role === "note";
    if (isNote ? !opts.notes : !opts.steps) continue;
    const t = stepTime(step, tempo);
    if (t == null || !inRange(t)) continue;
    const tt = t + shift;
    if (!fits(tt)) { counts.outside++; continue; }
    const section = tempoAt(target, tt);
    const beat = Math.round(((tt - Number(section.offset_sec || 0)) / secondsPerBeat(section)) * 2) / 2;
    rows.steps.push({
      id: uuid(), project_id: targetId, tempo_section_id: section.id, role: step.role,
      group_number: step.group_number ?? 0, beat_pos: beat, length_beats: step.length_beats ?? 1,
      foot: step.foot ?? null, value: step.value ?? null,
    });
    counts[isNote ? "notes" : "steps"]++;
  }

  if (opts.segments) {
    for (const s of segments) {
      const t = Number(s.timestamp);
      if (!inRange(t)) continue;
      if (!fits(t + shift)) { counts.outside++; continue; }
      rows.choreo_segments.push({ id: uuid(), project_id: targetId, timestamp: round3(t + shift), label: s.label, notes: s.notes });
      counts.segments++;
    }
  }

  if (opts.pairs) {
    for (const p of persons) {
      if (!opts.replace && existingNumbers.has(Number(p.number))) continue;
      rows.persons.push({ id: uuid(), project_id: targetId, number: p.number, name: p.name });
      counts.persons++;
    }
    const newIds = {};
    for (const part of parts) {
      const start = Number(part.start_sec) || 0;
      const end = part.end_sec == null ? Infinity : Number(part.end_sec);
      // Abschnitt, der den gewählten Bereich berührt
      if ((opts.to != null && start >= opts.to) || (opts.from != null && end <= opts.from)) continue;
      const s2 = Math.max(0, start + shift);
      const e2 = end === Infinity ? null : end + shift;
      if (e2 != null && e2 <= 0) { counts.outside++; continue; }
      const id = uuid();
      newIds[part.id] = id;
      rows.parts.push({ id, project_id: targetId, sort_index: part.sort_index, label: part.label,
        start_sec: round3(s2), end_sec: e2 == null ? null : round3(e2), group_names: part.group_names });
      counts.parts++;
    }
    for (const m of memberships) {
      if (!newIds[m.part_id]) continue;
      rows.group_memberships.push({ id: uuid(), part_id: newIds[m.part_id], person_number: m.person_number, group_number: m.group_number });
    }
  }

  const clear = opts.replace
    ? [opts.steps && "steps", opts.notes && "notes", opts.segments && "segments", opts.pairs && "pairs"].filter(Boolean)
    : [];
  return { rows, clear, counts };
}
