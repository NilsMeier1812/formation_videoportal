// Übernahme der Choreo-Planer-Daten aus Supabase nach Cloudflare (D1 + R2).
//
// Liest alle Tabellen über die öffentliche Lese-Schnittstelle von Supabase,
// lädt die Musikdateien herunter und schreibt in das Ausgabeverzeichnis:
//   migrate.sql   INSERT … ON CONFLICT für D1 (wiederholbar, überschreibt nichts Neueres doppelt)
//   audio/        Musikdateien für R2 (Schlüssel audio/<datei>)
//   audio.json    Liste der Dateien mit Content-Type
//   report.md     Bericht: Anzahlen, übersprungene Zeilen, unbekannte Spalten
//
// Supabase selbst wird nur gelesen, nie verändert.
//
// Aufruf:  node scripts/migrate-from-supabase.mjs --out migration [--no-audio]
// Hochladen übernimmt der GitHub-Workflow „Choreo-Daten übernehmen“.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TABLES, buildMigration, reportMarkdown } from "./migration-lib.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://qgklrvagzfvqbbpgpfdl.supabase.co";
// Öffentlicher Lese-Schlüssel (steht auch im alten Planer im Browser-Code)
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFna2xydmFnemZ2cWJicGdwZmRsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxMTkyNjksImV4cCI6MjA5NzY5NTI2OX0.3Jo7IBQYHDOr1hNRzuV3zxnof0zI4lD2kF6XqT2QjIs";
const PAGE = 1000;

// ---------------- Supabase lesen ----------------

async function fetchTable(table) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*&order=id`, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Range: `${from}-${from + PAGE - 1}`,
        "Range-Unit": "items",
      },
    });
    if (!res.ok && res.status !== 206) throw new Error(`${table}: HTTP ${res.status} ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

// ---------------- Ablauf ----------------

async function main() {
  const args = process.argv.slice(2);
  const out = args[args.indexOf("--out") + 1] || "migration";
  const mode = process.env.MODE || "probelauf";
  mkdirSync(join(out, "audio"), { recursive: true });

  const data = {};
  for (const { name } of TABLES) {
    data[name] = await fetchTable(name);
    console.log(`${name}: ${data[name].length} Zeilen`);
  }
  const { sql, report } = buildMigration(data);

  const audioList = [];
  if (!args.includes("--no-audio")) {
    for (const a of report.audio) {
      const res = await fetch(a.source);
      if (!res.ok) {
        report.skipped.push(`Musik ${a.file}: Download fehlgeschlagen (HTTP ${res.status})`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(join(out, "audio", a.file), buf);
      const type = a.file.endsWith(".wav") ? "audio/wav" : "audio/mpeg";
      audioList.push({ file: a.file, type, bytes: buf.length });
      console.log(`Musik: ${a.file} (${(buf.length / 1e6).toFixed(1)} MB)`);
    }
  }

  writeFileSync(join(out, "migrate.sql"), sql);
  writeFileSync(join(out, "audio.json"), JSON.stringify(audioList, null, 2));
  writeFileSync(join(out, "report.md"), reportMarkdown(report, { mode }));
  console.log(`\nFertig: ${out}/migrate.sql, ${audioList.length} Musikdateien, Bericht in ${out}/report.md`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
