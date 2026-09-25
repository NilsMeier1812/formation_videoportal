// Reine Logik der Übernahme Supabase → D1 (ohne Netz und Dateisystem), damit testbar.
// Genutzt von scripts/migrate-from-supabase.mjs.

/** Zieltabellen in Eltern-zuerst-Reihenfolge, mit den Spalten, die übernommen werden. */
export const TABLES = [
  { name: "projects", columns: ["id", "title", "bpm", "time_signature", "audio_url", "grid_offset", "is_private", "created_at", "updated_at"] },
  { name: "tempo_sections", parent: ["project_id", "projects"], columns: ["id", "project_id", "sort_index", "label", "start_sec", "end_sec", "bpm", "time_signature", "offset_sec", "updated_at"] },
  { name: "choreo_segments", parent: ["project_id", "projects"], columns: ["id", "project_id", "timestamp", "label", "notes", "updated_at"] },
  { name: "persons", parent: ["project_id", "projects"], columns: ["id", "project_id", "number", "name"] },
  { name: "parts", parent: ["project_id", "projects"], columns: ["id", "project_id", "sort_index", "label", "start_sec", "end_sec", "group_names"] },
  { name: "group_memberships", parent: ["part_id", "parts"], columns: ["id", "part_id", "person_number", "group_number"] },
  { name: "steps", parent: ["project_id", "projects"], columns: ["id", "project_id", "tempo_section_id", "role", "group_number", "beat_pos", "length_beats", "foot", "value"] },
];
/** Spalten, die es in Supabase gibt, die wir aber bewusst nicht übernehmen. */
const IGNORED = new Set(["locked_by", "locked_by_name", "locked_at"]);

// ---------------- SQL ----------------

export function sqlValue(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "object") v = JSON.stringify(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

export function upsertSql(table, columns, row) {
  const values = columns.map((c) => sqlValue(row[c])).join(", ");
  const update = columns.filter((c) => c !== "id" && c !== "created_at").map((c) => `${c} = excluded.${c}`).join(", ");
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${values}) ON CONFLICT(id) DO UPDATE SET ${update};`;
}

/** Supabase-Storage-URL → Dateiname in R2, sonst null. */
export function audioFileName(url) {
  const m = /\/storage\/v1\/object\/public\/[^/]+\/([A-Za-z0-9_.-]+)$/.exec(String(url || ""));
  return m ? m[1] : null;
}

/**
 * Baut aus den Supabase-Zeilen SQL + Bericht. Rein (ohne Netz), damit testbar.
 * @param data { [table]: rows[] }
 */
export function buildMigration(data) {
  const statements = [];
  const report = { counts: {}, skipped: [], unknownColumns: {}, audio: [] };
  const ids = {};

  for (const { name, columns, parent } of TABLES) {
    const rows = data[name] || [];
    const known = new Set([...columns, ...IGNORED]);
    const unknown = new Set();
    ids[name] = new Set();
    let taken = 0;

    for (const original of rows) {
      const row = { ...original };
      for (const key of Object.keys(row)) if (!known.has(key)) unknown.add(key);

      if (!row.id) { report.skipped.push(`${name}: Zeile ohne id`); continue; }
      if (parent && !ids[parent[1]].has(row[parent[0]])) {
        report.skipped.push(`${name} ${row.id}: ${parent[0]}=${row[parent[0]]} gibt es nicht`);
        continue;
      }
      if (name === "projects") {
        row.title ??= "Ohne Titel";
        row.is_private = Boolean(row.is_private); // Spalte ist in D1 NOT NULL
        row.created_at ??= new Date().toISOString();
        const file = audioFileName(row.audio_url);
        if (file) {
          report.audio.push({ project: row.title, file, source: row.audio_url });
          row.audio_url = `/api/choreo/audio/${file}`;
        } else if (row.audio_url) {
          report.skipped.push(`projects ${row.id}: Musik-URL nicht erkannt, bleibt unverändert (${row.audio_url})`);
        }
      }
      // Schritte zu gelöschten Tempo-Abschnitten: ohne Abschnitt übernehmen statt verlieren
      if (name === "steps" && row.tempo_section_id && !ids.tempo_sections.has(row.tempo_section_id)) {
        report.skipped.push(`steps ${row.id}: Tempo-Abschnitt fehlt – ohne Abschnitt übernommen`);
        row.tempo_section_id = null;
      }

      statements.push(upsertSql(name, columns, row));
      ids[name].add(row.id);
      taken++;
    }
    report.counts[name] = { supabase: rows.length, uebernommen: taken };
    if (unknown.size) report.unknownColumns[name] = [...unknown];
  }
  return { statements, sql: statements.join("\n") + "\n", report };
}

export function reportMarkdown(report, { mode }) {
  const lines = [
    `## Choreo-Daten übernehmen – ${mode === "uebernehmen" ? "Übernahme" : "Probelauf"}`,
    "",
    "| Tabelle | in Supabase | übernommen |",
    "| --- | ---: | ---: |",
    ...Object.entries(report.counts).map(([t, c]) => `| ${t} | ${c.supabase} | ${c.uebernommen} |`),
    "",
    `**Musikdateien:** ${report.audio.length}`,
    ...report.audio.map((a) => `- ${a.project}: \`${a.file}\``),
    "",
  ];
  if (report.skipped.length) {
    lines.push(`**Hinweise (${report.skipped.length}):**`, ...report.skipped.slice(0, 200).map((s) => `- ${s}`), "");
  }
  const unknown = Object.entries(report.unknownColumns);
  if (unknown.length) {
    lines.push("**Spalten in Supabase, die nicht übernommen werden** (prüfen, ob darin etwas Wichtiges steht):",
      ...unknown.map(([t, cols]) => `- ${t}: ${cols.join(", ")}`), "");
  }
  if (mode !== "uebernehmen") lines.push("_Probelauf: In Cloudflare wurde nichts geschrieben._");
  return lines.join("\n") + "\n";
}
