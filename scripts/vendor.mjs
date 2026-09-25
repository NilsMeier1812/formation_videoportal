// Kopiert die Frontend-Bibliotheken aus node_modules nach public/vendor.
// Die App lädt nichts von fremden CDNs – wichtig für Offline-Betrieb der PWA.
// Aufruf nach einem Versions-Update: `npm run vendor` und das Ergebnis committen.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const modules = new URL("../node_modules/", import.meta.url);
const out = new URL("../public/vendor/", import.meta.url);
mkdirSync(out, { recursive: true });

const files = {
  "alpine.esm.js": "alpinejs/dist/module.esm.min.js",
  "dexie.mjs": "dexie/dist/modern/dexie.min.mjs",
  "wavesurfer.esm.js": "wavesurfer.js/dist/wavesurfer.esm.js",
  "wavesurfer-regions.esm.js": "wavesurfer.js/dist/plugins/regions.esm.js",
  // Nur bis zum Umzug der Planer-Daten nach Cloudflare (Schritt B)
  "supabase.umd.js": "@supabase/supabase-js/dist/umd/supabase.js",
};

for (const [target, source] of Object.entries(files)) {
  const pkg = source.split("/dist/")[0];
  const { version } = JSON.parse(readFileSync(new URL(`${pkg}/package.json`, modules), "utf8"));
  const code = readFileSync(new URL(source, modules), "utf8")
    .replace(/\n\/\/# sourceMappingURL=.*$/m, "");
  writeFileSync(new URL(target, out), `/* ${pkg}@${version} */\n${code}`);
  console.log(`${target}  ←  ${pkg}@${version}`);
}
