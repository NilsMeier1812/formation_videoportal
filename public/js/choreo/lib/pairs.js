// Paar zum Namen finden (rein, testbar): Wer sich mit Namen anmeldet, bekommt sein Paar
// automatisch gewählt – sofern der Name eindeutig zu genau einem Paar passt.
//
// Paar-Namen sind z. B. „Anna & Ben“, „Anna und Ben“, „Anna/Ben“, „Anna Müller, Ben Schulz“.
// Ein Treffer ist: ganzer Name gleich, oder der Vorname (erstes Wort) gleich dem Vornamen
// einer Person im Paar. Groß/klein und Akzente egal.

const norm = (s) => String(s || "")
  .normalize("NFD").replace(/[̀-ͯ]/g, "") // é → e, ü → u
  .toLowerCase().replace(/ß/g, "ss").replace(/\s+/g, " ").trim();

/** „Anna & Ben“ → ["anna", "ben"] */
function peopleOf(pairName) {
  return norm(pairName).split(/\s*(?:&|\+|\/|,|;|\bund\b|\bu\.\s)\s*/).map((x) => x.trim()).filter(Boolean);
}

/** Nummer des passenden Paares – oder 0 (kein Name, kein oder mehrere Treffer). */
export function pairForName(persons, name) {
  const who = norm(name);
  if (!who) return 0;
  const first = who.split(" ")[0];
  const hits = persons.filter((p) => peopleOf(p.name).some((x) => x === who || x.split(" ")[0] === first));
  return hits.length === 1 ? Number(hits[0].number) : 0;
}
